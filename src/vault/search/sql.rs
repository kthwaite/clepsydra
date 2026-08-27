use rusqlite::{Connection, params_from_iter, types::Value};

use super::SearchExecutionError;
use super::query::{
    SearchDiagnostic, SearchDiagnosticKind, SearchExpr, SearchField, SearchQueryError, SearchSpan,
    TextMode,
};
use crate::vault::index::SearchResult;

struct TextLeaf {
    ordinal: usize,
    parameter: usize,
    positive: bool,
    support: Option<String>,
}

enum CompiledExpression {
    Predicate(String),
    PositiveText { ordinal: usize, predicate: String },
    All(Vec<CompiledExpression>),
    Any(Vec<CompiledExpression>),
}

impl CompiledExpression {
    fn render(&self) -> String {
        match self {
            Self::Predicate(predicate) | Self::PositiveText { predicate, .. } => predicate.clone(),
            Self::All(children) => format!(
                "({})",
                children
                    .iter()
                    .map(Self::render)
                    .collect::<Vec<_>>()
                    .join(" AND ")
            ),
            Self::Any(children) => format!(
                "({})",
                children
                    .iter()
                    .map(Self::render)
                    .collect::<Vec<_>>()
                    .join(" OR ")
            ),
        }
    }

    fn collect_positive_support(&self, context: &str, support: &mut [Option<String>]) {
        match self {
            Self::Predicate(_) => {}
            Self::PositiveText { ordinal, .. } => {
                support[*ordinal] = Some(context.to_owned());
            }
            Self::Any(children) => {
                for child in children {
                    child.collect_positive_support(context, support);
                }
            }
            Self::All(children) => {
                let rendered = children.iter().map(Self::render).collect::<Vec<_>>();
                for (index, child) in children.iter().enumerate() {
                    let mut child_context = String::from("(");
                    child_context.push_str(context);
                    for (sibling_index, sibling) in rendered.iter().enumerate() {
                        if sibling_index != index {
                            child_context.push_str(" AND ");
                            child_context.push_str(sibling);
                        }
                    }
                    child_context.push(')');
                    child.collect_positive_support(&child_context, support);
                }
            }
        }
    }
}

struct Compiler<'a> {
    input: &'a str,
    parameters: Vec<Value>,
    text_leaves: Vec<TextLeaf>,
}

impl<'a> Compiler<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            input,
            parameters: Vec::new(),
            text_leaves: Vec::new(),
        }
    }

    fn compile(
        mut self,
        expression: &SearchExpr,
        limit: usize,
    ) -> Result<CompiledQuery, SearchQueryError> {
        let expression = self.compile_expression(expression, false)?;
        let condition = expression.render();
        let mut support = vec![None; self.text_leaves.len()];
        expression.collect_positive_support("1", &mut support);
        for (leaf, support) in self.text_leaves.iter_mut().zip(support) {
            if leaf.positive {
                leaf.support = Some(
                    support.expect("every positive text leaf belongs to the compiled expression"),
                );
            }
        }

        let common_table_expressions = self.common_table_expressions();
        let snippet = self.snippet_expression("p.id", "best_positive.ordinal");
        let limit_parameter = self.bind(Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)));
        let sql = format!(
            "WITH {common_table_expressions}\n\
             SELECT p.id, p.path, p.title,\n\
                    COALESCE({snippet}, ''),\n\
                    COALESCE(best_positive.rank, 0.0)\n\
             FROM pages AS p\n\
             LEFT JOIN best_positive ON best_positive.page_id = p.id\n\
             WHERE {condition}\n\
             ORDER BY (best_positive.page_id IS NOT NULL) DESC,\n\
                      best_positive.rank ASC,\n\
                      CASE\n\
                          WHEN best_positive.page_id IS NULL THEN p.updated_at IS NULL\n\
                          ELSE 0\n\
                      END ASC,\n\
                      CASE\n\
                          WHEN best_positive.page_id IS NULL THEN p.updated_at\n\
                      END DESC,\n\
                      p.path COLLATE NOCASE ASC,\n\
                      p.id ASC\n\
             LIMIT ?{limit_parameter}"
        );

        Ok(CompiledQuery {
            sql,
            parameters: self.parameters,
        })
    }

    fn compile_expression(
        &mut self,
        expression: &SearchExpr,
        negated: bool,
    ) -> Result<CompiledExpression, SearchQueryError> {
        match expression {
            SearchExpr::Text {
                value, mode, span, ..
            } => {
                let fts = fts_expression(self.input, value, *mode, *span)?;
                let parameter = self.bind(Value::Text(fts));
                let ordinal = self.text_leaves.len();
                self.text_leaves.push(TextLeaf {
                    ordinal,
                    parameter,
                    positive: !negated,
                    support: None,
                });
                let predicate = format!(
                    "(EXISTS (SELECT 1 FROM text_{ordinal} \
                     WHERE text_{ordinal}.page_id = p.id))"
                );
                if negated {
                    Ok(CompiledExpression::Predicate(format!("(NOT {predicate})")))
                } else {
                    Ok(CompiledExpression::PositiveText { ordinal, predicate })
                }
            }
            SearchExpr::Field { field, value, .. } => {
                let parameter = self.bind(Value::Text(value.clone()));
                let predicate = match field {
                    SearchField::Kind => format!("(p.kind = ?{parameter})"),
                    SearchField::Project => {
                        format!("(COALESCE(p.project = ?{parameter}, 0))")
                    }
                    SearchField::Tag => format!(
                        "(EXISTS (SELECT 1 FROM tags AS searched_tags \
                         WHERE searched_tags.page_id = p.id \
                         AND searched_tags.tag = ?{parameter}))"
                    ),
                };
                Ok(CompiledExpression::Predicate(if negated {
                    format!("(NOT {predicate})")
                } else {
                    predicate
                }))
            }
            SearchExpr::All { children, .. } => {
                let children = children
                    .iter()
                    .map(|child| self.compile_expression(child, negated))
                    .collect::<Result<Vec<_>, _>>()?;
                debug_assert!(!children.is_empty());
                Ok(if negated {
                    CompiledExpression::Any(children)
                } else {
                    CompiledExpression::All(children)
                })
            }
            SearchExpr::Any { children, .. } => {
                let children = children
                    .iter()
                    .map(|child| self.compile_expression(child, negated))
                    .collect::<Result<Vec<_>, _>>()?;
                debug_assert!(!children.is_empty());
                Ok(if negated {
                    CompiledExpression::All(children)
                } else {
                    CompiledExpression::Any(children)
                })
            }
            SearchExpr::Not { child, .. } => self.compile_expression(child, !negated),
        }
    }

    fn common_table_expressions(&self) -> String {
        let mut expressions = self
            .text_leaves
            .iter()
            .map(|leaf| {
                if leaf.positive {
                    format!(
                        "text_{ordinal}(page_id, rank) AS (\n\
                             SELECT page_id, bm25(pages_fts)\n\
                             FROM pages_fts\n\
                             WHERE pages_fts MATCH ?{parameter}\n\
                         )",
                        ordinal = leaf.ordinal,
                        parameter = leaf.parameter,
                    )
                } else {
                    format!(
                        "text_{ordinal}(page_id) AS (\n\
                             SELECT page_id\n\
                             FROM pages_fts\n\
                             WHERE pages_fts MATCH ?{parameter}\n\
                         )",
                        ordinal = leaf.ordinal,
                        parameter = leaf.parameter,
                    )
                }
            })
            .collect::<Vec<_>>();

        let positive = self
            .text_leaves
            .iter()
            .filter(|leaf| leaf.positive)
            .map(|leaf| {
                let support = leaf
                    .support
                    .as_deref()
                    .expect("positive text support is compiled before CTE generation");
                format!(
                    "SELECT text_{ordinal}.page_id, text_{ordinal}.rank, {ordinal} AS ordinal\n\
                     FROM text_{ordinal}\n\
                     JOIN pages AS p ON p.id = text_{ordinal}.page_id\n\
                     WHERE {support}",
                    ordinal = leaf.ordinal,
                )
            })
            .collect::<Vec<_>>();

        if positive.is_empty() {
            expressions.push(
                "best_positive(page_id, rank, ordinal) AS (\n\
                     SELECT CAST(NULL AS TEXT), CAST(NULL AS REAL), CAST(NULL AS INTEGER)\n\
                     WHERE 0\n\
                 )"
                .to_owned(),
            );
        } else {
            expressions.push(format!(
                "positive_matches(page_id, rank, ordinal) AS (\n{}\n                 )",
                positive
                    .into_iter()
                    .map(|select| format!("                     {select}"))
                    .collect::<Vec<_>>()
                    .join("\n                     UNION ALL\n")
            ));
            expressions.push(
                "best_positive(page_id, rank, ordinal) AS (\n\
                     SELECT page_id, rank, ordinal\n\
                     FROM (\n\
                         SELECT page_id, rank, ordinal,\n\
                                ROW_NUMBER() OVER (\n\
                                    PARTITION BY page_id\n\
                                    ORDER BY rank ASC, ordinal ASC\n\
                                ) AS match_order\n\
                         FROM positive_matches\n\
                     )\n\
                     WHERE match_order = 1\n\
                 )"
                .to_owned(),
            );
        }

        expressions.join(",\n")
    }

    fn snippet_expression(&self, page_id: &str, ordinal: &str) -> String {
        let cases = self
            .text_leaves
            .iter()
            .filter(|leaf| leaf.positive)
            .map(|leaf| {
                format!(
                    "WHEN {leaf_ordinal} THEN (\n\
                         SELECT snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32)\n\
                         FROM pages_fts\n\
                         WHERE pages_fts.page_id = {page_id}\n\
                           AND pages_fts MATCH ?{parameter}\n\
                     )",
                    leaf_ordinal = leaf.ordinal,
                    parameter = leaf.parameter,
                )
            })
            .collect::<Vec<_>>();
        if cases.is_empty() {
            "''".to_owned()
        } else {
            format!("CASE {ordinal}\n{}\nELSE '' END", cases.join("\n"))
        }
    }

    fn bind(&mut self, value: Value) -> usize {
        self.parameters.push(value);
        self.parameters.len()
    }
}

struct CompiledQuery {
    sql: String,
    parameters: Vec<Value>,
}

fn compile_query(
    input: &str,
    expression: &SearchExpr,
    limit: usize,
) -> Result<CompiledQuery, SearchQueryError> {
    if let Some(leaves) = ordinary_positive_text_leaves(expression) {
        compile_ordinary_text(input, &leaves, limit)
    } else {
        Compiler::new(input).compile(expression, limit)
    }
}

fn ordinary_positive_text_leaves(
    expression: &SearchExpr,
) -> Option<Vec<(&str, TextMode, SearchSpan)>> {
    match expression {
        SearchExpr::Text {
            value, mode, span, ..
        } => Some(vec![(value.as_str(), *mode, *span)]),
        SearchExpr::All { children, .. } => children
            .iter()
            .map(|child| match child {
                SearchExpr::Text {
                    value, mode, span, ..
                } => Some((value.as_str(), *mode, *span)),
                _ => None,
            })
            .collect(),
        SearchExpr::Field { .. } | SearchExpr::Any { .. } | SearchExpr::Not { .. } => None,
    }
}

fn compile_ordinary_text(
    input: &str,
    leaves: &[(&str, TextMode, SearchSpan)],
    limit: usize,
) -> Result<CompiledQuery, SearchQueryError> {
    debug_assert!(!leaves.is_empty());
    let mut parameters = leaves
        .iter()
        .map(|(value, mode, span)| fts_expression(input, value, *mode, *span).map(Value::Text))
        .collect::<Result<Vec<_>, _>>()?;
    let text_ctes = leaves
        .iter()
        .enumerate()
        .map(|(ordinal, _)| {
            let parameter = ordinal + 1;
            format!(
                "text_{ordinal}(page_id, rank) AS MATERIALIZED (\n\
                     SELECT page_id, bm25(pages_fts)\n\
                     FROM pages_fts\n\
                     WHERE pages_fts MATCH ?{parameter}\n\
                 )"
            )
        })
        .collect::<Vec<_>>();
    let required = if leaves.len() == 1 {
        "SELECT page_id FROM text_0".to_owned()
    } else {
        let joins = (1..leaves.len())
            .map(|ordinal| {
                format!(
                    "JOIN text_{ordinal} \
                     ON text_{ordinal}.page_id = text_0.page_id"
                )
            })
            .collect::<Vec<_>>()
            .join("\n                     ");
        format!("SELECT text_0.page_id FROM text_0\n                     {joins}")
    };
    let positive_ranks = (0..leaves.len())
        .map(|ordinal| format!("SELECT page_id, rank, {ordinal} AS ordinal FROM text_{ordinal}"))
        .collect::<Vec<_>>()
        .join("\n                     UNION ALL\n");
    let snippet_cases = (0..leaves.len())
        .map(|ordinal| {
            let parameter = ordinal + 1;
            format!(
                "WHEN {ordinal} THEN (\n\
                     SELECT snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32)\n\
                     FROM pages_fts\n\
                     WHERE pages_fts.page_id = ranked.page_id\n\
                       AND pages_fts MATCH ?{parameter}\n\
                 )"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    parameters.push(Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)));
    let limit_parameter = parameters.len();
    let sql = format!(
        "WITH {text_ctes},\n\
         required(page_id) AS (\n\
             {required}\n\
         ),\n\
         positive_ranks(page_id, rank, ordinal) AS (\n\
                     {positive_ranks}\n\
         ),\n\
         candidate_matches(page_id, path, title, id, rank, ordinal, match_order) AS (\n\
             SELECT required.page_id, p.path, p.title, p.id,\n\
                    positive_ranks.rank, positive_ranks.ordinal,\n\
                    ROW_NUMBER() OVER (\n\
                        PARTITION BY required.page_id\n\
                        ORDER BY positive_ranks.rank ASC, positive_ranks.ordinal ASC\n\
                    )\n\
             FROM required\n\
             JOIN positive_ranks ON positive_ranks.page_id = required.page_id\n\
             JOIN pages AS p ON p.id = required.page_id\n\
         ),\n\
         ranked(page_id, path, title, id, rank, ordinal) AS MATERIALIZED (\n\
             SELECT page_id, path, title, id, rank, ordinal\n\
             FROM candidate_matches\n\
             WHERE match_order = 1\n\
             ORDER BY rank ASC, path COLLATE NOCASE ASC, id ASC\n\
             LIMIT ?{limit_parameter}\n\
         )\n\
         SELECT ranked.page_id, ranked.path, ranked.title,\n\
                COALESCE(CASE ranked.ordinal\n\
                    {snippet_cases}\n\
                    ELSE ''\n\
                END, ''),\n\
                ranked.rank\n\
         FROM ranked\n\
         ORDER BY ranked.rank ASC, ranked.path COLLATE NOCASE ASC, ranked.id ASC",
        text_ctes = text_ctes.join(",\n"),
    );

    Ok(CompiledQuery { sql, parameters })
}

pub(super) fn execute(
    connection: &Connection,
    input: &str,
    expression: &SearchExpr,
    limit: usize,
) -> Result<Vec<SearchResult>, SearchExecutionError> {
    let compiled = compile_query(input, expression, limit)?;
    let mut statement = connection.prepare(&compiled.sql)?;
    let rows = statement.query_map(params_from_iter(compiled.parameters.iter()), |row| {
        Ok(SearchResult {
            page_id: row.get(0)?,
            path: row.get(1)?,
            title: row.get(2)?,
            snippet: row.get(3)?,
            rank: row.get(4)?,
        })
    })?;

    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn fts_expression(
    input: &str,
    value: &str,
    mode: TextMode,
    span: SearchSpan,
) -> Result<String, SearchQueryError> {
    let expression = match mode {
        TextMode::Prefix => prefix_fts_expression(value),
        TextMode::Phrase if value.chars().any(char::is_alphanumeric) => {
            format!("\"{}\"", escape_fts_phrase(value))
        }
        TextMode::Phrase => String::new(),
    };

    if expression.is_empty() {
        let column = input[..span.start].chars().count() + 1;
        return Err(SearchQueryError {
            diagnostic: SearchDiagnostic {
                message: format!("text contains no searchable token at column {column}"),
                kind: SearchDiagnosticKind::EmptyValue,
                span,
                column,
            },
        });
    }

    Ok(expression)
}

fn prefix_fts_expression(value: &str) -> String {
    let mut expression = String::with_capacity(value.len().saturating_add(3));

    for term in value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|term| !term.is_empty())
    {
        if !expression.is_empty() {
            expression.push_str(" AND ");
        }
        expression.push('"');
        expression.push_str(term);
        expression.push_str("\"*");
    }

    expression
}

fn escape_fts_phrase(value: &str) -> String {
    value.replace('"', "\"\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::search::query::parse;

    fn span(end: usize) -> SearchSpan {
        SearchSpan { start: 0, end }
    }

    #[test]
    fn prefix_fts_quotes_every_token_and_owns_all_operators() {
        assert_eq!(
            fts_expression("OR*not", "OR*not", TextMode::Prefix, span(6)).unwrap(),
            "\"OR\"* AND \"not\"*"
        );
    }

    #[test]
    fn phrase_fts_escapes_quotes_without_promoting_authored_operators() {
        assert_eq!(
            fts_expression(
                r#"say "hi" OR *"#,
                r#"say "hi" OR *"#,
                TextMode::Phrase,
                span(13),
            )
            .unwrap(),
            r#""say ""hi"" OR *""#
        );
    }

    #[test]
    fn compiler_binds_metadata_and_generated_fts_values() {
        let expression = parse(r#"(tag:beer | project:"Kitchen Shelf") clep"#).unwrap();
        let compiled = Compiler::new(r#"(tag:beer | project:"Kitchen Shelf") clep"#)
            .compile(&expression, 7)
            .unwrap();

        assert!(!compiled.sql.contains("beer"));
        assert!(!compiled.sql.contains("Kitchen Shelf"));
        assert!(!compiled.sql.contains("clep"));
        assert_eq!(
            compiled.parameters,
            [
                Value::Text("beer".to_owned()),
                Value::Text("Kitchen Shelf".to_owned()),
                Value::Text("\"clep\"*".to_owned()),
                Value::Integer(7),
            ]
        );
    }

    #[test]
    fn only_even_negation_text_leaves_contribute_rank_and_snippets() {
        let expression = parse("-foo | --bar").unwrap();
        let mut compiler = Compiler::new("-foo | --bar");
        compiler.compile_expression(&expression, false).unwrap();

        assert_eq!(
            compiler
                .text_leaves
                .iter()
                .map(|leaf| leaf.positive)
                .collect::<Vec<_>>(),
            [false, true]
        );
    }

    #[test]
    fn ordinary_positive_search_uses_a_bounded_fts_driven_plan() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE pages (
                     id TEXT PRIMARY KEY,
                     path TEXT NOT NULL,
                     title TEXT,
                     updated_at TEXT,
                     kind TEXT NOT NULL,
                     project TEXT
                 );
                 CREATE VIRTUAL TABLE pages_fts USING fts5(
                     page_id UNINDEXED,
                     path UNINDEXED,
                     title,
                     body,
                     tokenize='porter unicode61'
                 );",
            )
            .unwrap();
        let expression = parse("bro").unwrap();
        let compiled = compile_query("bro", &expression, 3).unwrap();
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {}", compiled.sql))
            .unwrap();
        let details = statement
            .query_map(params_from_iter(compiled.parameters.iter()), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();

        assert!(
            details
                .iter()
                .any(|detail| detail.contains("MATERIALIZE ranked")),
            "{details:#?}"
        );
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("VIRTUAL TABLE INDEX")),
            "{details:#?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| detail != "SCAN p" && !detail.starts_with("SCAN p ")),
            "{details:#?}"
        );
    }
}
