use rusqlite::{Connection, params_from_iter, types::Value};

use super::query::{
    SearchDiagnostic, SearchDiagnosticKind, SearchExpr, SearchField, SearchQueryError, SearchSpan,
    TextMode,
};
use super::SearchExecutionError;
use crate::vault::index::SearchResult;

struct TextLeaf {
    ordinal: usize,
    parameter: usize,
    positive: bool,
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
        let condition = self.compile_expression(expression, false)?;
        let common_table_expressions = self.common_table_expressions();
        let limit_parameter = self.bind(Value::Integer(i64::try_from(limit).unwrap_or(i64::MAX)));
        let sql = format!(
            "WITH {common_table_expressions}\n\
             SELECT p.id, p.path, p.title,\n\
                    COALESCE(best_positive.snippet, ''),\n\
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
    ) -> Result<String, SearchQueryError> {
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
                });
                Ok(format!(
                    "(EXISTS (SELECT 1 FROM text_{ordinal} WHERE text_{ordinal}.page_id = p.id))"
                ))
            }
            SearchExpr::Field { field, value, .. } => {
                let parameter = self.bind(Value::Text(value.clone()));
                Ok(match field {
                    SearchField::Kind => format!("(p.kind = ?{parameter})"),
                    SearchField::Project => {
                        format!("(COALESCE(p.project = ?{parameter}, 0))")
                    }
                    SearchField::Tag => format!(
                        "(EXISTS (SELECT 1 FROM tags AS searched_tags \
                         WHERE searched_tags.page_id = p.id \
                         AND searched_tags.tag = ?{parameter}))"
                    ),
                })
            }
            SearchExpr::All { children, .. } => {
                let children = children
                    .iter()
                    .map(|child| self.compile_expression(child, negated))
                    .collect::<Result<Vec<_>, _>>()?;
                debug_assert!(!children.is_empty());
                Ok(format!("({})", children.join(" AND ")))
            }
            SearchExpr::Any { children, .. } => {
                let children = children
                    .iter()
                    .map(|child| self.compile_expression(child, negated))
                    .collect::<Result<Vec<_>, _>>()?;
                debug_assert!(!children.is_empty());
                Ok(format!("({})", children.join(" OR ")))
            }
            SearchExpr::Not { child, .. } => Ok(format!(
                "(NOT {})",
                self.compile_expression(child, !negated)?
            )),
        }
    }

    fn common_table_expressions(&self) -> String {
        let mut expressions = self
            .text_leaves
            .iter()
            .map(|leaf| {
                if leaf.positive {
                    format!(
                        "text_{ordinal}(page_id, rank, snippet) AS (\n\
                             SELECT page_id, bm25(pages_fts),\n\
                                    snippet(pages_fts, 3, '<mark>', '</mark>', '…', 32)\n\
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
                format!(
                    "SELECT page_id, rank, snippet, {} AS ordinal FROM text_{}",
                    leaf.ordinal, leaf.ordinal
                )
            })
            .collect::<Vec<_>>();

        if positive.is_empty() {
            expressions.push(
                "best_positive(page_id, rank, snippet) AS (\n\
                     SELECT CAST(NULL AS TEXT), CAST(NULL AS REAL), CAST(NULL AS TEXT)\n\
                     WHERE 0\n\
                 )"
                    .to_owned(),
            );
        } else {
            expressions.push(format!(
                "positive_matches(page_id, rank, snippet, ordinal) AS (\n{}\n                 )",
                positive
                    .into_iter()
                    .map(|select| format!("                     {select}"))
                    .collect::<Vec<_>>()
                    .join("\n                     UNION ALL\n")
            ));
            expressions.push(
                "best_positive(page_id, rank, snippet) AS (\n\
                     SELECT page_id, rank, snippet\n\
                     FROM (\n\
                         SELECT page_id, rank, snippet,\n\
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

    fn bind(&mut self, value: Value) -> usize {
        self.parameters.push(value);
        self.parameters.len()
    }
}

struct CompiledQuery {
    sql: String,
    parameters: Vec<Value>,
}

pub(super) fn execute(
    connection: &Connection,
    input: &str,
    expression: &SearchExpr,
    limit: usize,
) -> Result<Vec<SearchResult>, SearchExecutionError> {
    let compiled = Compiler::new(input).compile(expression, limit)?;
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
}
