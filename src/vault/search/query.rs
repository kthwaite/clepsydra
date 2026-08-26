use std::fmt;

use crate::vault::kind::Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SearchSpan {
    pub(crate) start: usize,
    pub(crate) end: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TextMode {
    Prefix,
    Phrase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SearchField {
    Kind,
    Tag,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SearchExpr {
    Text {
        value: String,
        mode: TextMode,
        span: SearchSpan,
    },
    Field {
        field: SearchField,
        value: String,
        span: SearchSpan,
    },
    All {
        children: Vec<SearchExpr>,
        span: SearchSpan,
    },
    Any {
        children: Vec<SearchExpr>,
        span: SearchSpan,
    },
    Not {
        child: Box<SearchExpr>,
        span: SearchSpan,
    },
}

impl SearchExpr {
    fn span(&self) -> SearchSpan {
        match self {
            SearchExpr::Text { span, .. }
            | SearchExpr::Field { span, .. }
            | SearchExpr::All { span, .. }
            | SearchExpr::Any { span, .. }
            | SearchExpr::Not { span, .. } => *span,
        }
    }

    fn set_span(&mut self, new_span: SearchSpan) {
        match self {
            SearchExpr::Text { span, .. }
            | SearchExpr::Field { span, .. }
            | SearchExpr::All { span, .. }
            | SearchExpr::Any { span, .. }
            | SearchExpr::Not { span, .. } => *span = new_span,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SearchDiagnosticKind {
    UnknownField,
    MissingFieldValue,
    UnknownKind,
    UnmatchedQuote,
    UnexpectedParenthesis,
    UnmatchedParenthesis,
    DanglingOr,
    DanglingNot,
    EmptyGroup,
    EmptyValue,
    UnexpectedColon,
    ExpectedExpression,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchDiagnostic {
    pub(crate) message: String,
    pub(crate) kind: SearchDiagnosticKind,
    pub(crate) span: SearchSpan,
    pub(crate) column: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SearchQueryError {
    pub(crate) diagnostic: SearchDiagnostic,
}

impl SearchQueryError {
    fn new(
        input: &str,
        kind: SearchDiagnosticKind,
        span: SearchSpan,
        message: impl fmt::Display,
    ) -> Self {
        let column = input[..span.start].chars().count() + 1;
        Self {
            diagnostic: SearchDiagnostic {
                message: format!("{message} at column {column}"),
                kind,
                span,
                column,
            },
        }
    }
}

impl fmt::Display for SearchQueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.diagnostic.message)
    }
}

impl std::error::Error for SearchQueryError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TokenKind {
    Word(String),
    Quoted(String),
    Colon,
    Pipe,
    Minus,
    LeftParenthesis,
    RightParenthesis,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    span: SearchSpan,
}

pub(super) fn parse(input: &str) -> Result<SearchExpr, SearchQueryError> {
    let tokens = lex(input)?;
    Parser {
        input,
        tokens,
        position: 0,
    }
    .parse()
}

fn lex(input: &str) -> Result<Vec<Token>, SearchQueryError> {
    let mut tokens = Vec::new();
    let mut characters = input.char_indices().peekable();

    while let Some(&(start, character)) = characters.peek() {
        if character.is_whitespace() {
            characters.next();
            continue;
        }

        let token = match character {
            ':' => {
                characters.next();
                Token {
                    kind: TokenKind::Colon,
                    span: SearchSpan {
                        start,
                        end: start + character.len_utf8(),
                    },
                }
            }
            '|' => {
                characters.next();
                Token {
                    kind: TokenKind::Pipe,
                    span: SearchSpan {
                        start,
                        end: start + character.len_utf8(),
                    },
                }
            }
            '-' => {
                characters.next();
                Token {
                    kind: TokenKind::Minus,
                    span: SearchSpan {
                        start,
                        end: start + character.len_utf8(),
                    },
                }
            }
            '(' => {
                characters.next();
                Token {
                    kind: TokenKind::LeftParenthesis,
                    span: SearchSpan {
                        start,
                        end: start + character.len_utf8(),
                    },
                }
            }
            ')' => {
                characters.next();
                Token {
                    kind: TokenKind::RightParenthesis,
                    span: SearchSpan {
                        start,
                        end: start + character.len_utf8(),
                    },
                }
            }
            '"' => lex_quoted(input, &mut characters, start)?,
            _ => {
                let mut value = String::new();
                let mut end = start;
                while let Some(&(index, next)) = characters.peek() {
                    if next.is_whitespace() || matches!(next, '"' | ':' | '|' | '(' | ')') {
                        break;
                    }
                    characters.next();
                    value.push(next);
                    end = index + next.len_utf8();
                }
                Token {
                    kind: TokenKind::Word(value),
                    span: SearchSpan { start, end },
                }
            }
        };
        tokens.push(token);
    }

    Ok(tokens)
}

fn lex_quoted(
    input: &str,
    characters: &mut std::iter::Peekable<std::str::CharIndices<'_>>,
    start: usize,
) -> Result<Token, SearchQueryError> {
    characters.next();
    let mut value = String::new();

    while let Some((index, character)) = characters.next() {
        match character {
            '"' => {
                return Ok(Token {
                    kind: TokenKind::Quoted(value),
                    span: SearchSpan {
                        start,
                        end: index + character.len_utf8(),
                    },
                });
            }
            '\\' => match characters.peek().copied() {
                Some((_, escaped @ ('"' | '\\'))) => {
                    characters.next();
                    value.push(escaped);
                }
                _ => value.push(character),
            },
            _ => value.push(character),
        }
    }

    Err(SearchQueryError::new(
        input,
        SearchDiagnosticKind::UnmatchedQuote,
        SearchSpan {
            start,
            end: input.len(),
        },
        "unterminated quoted value",
    ))
}

struct Parser<'a> {
    input: &'a str,
    tokens: Vec<Token>,
    position: usize,
}

impl Parser<'_> {
    fn parse(mut self) -> Result<SearchExpr, SearchQueryError> {
        if self.tokens.is_empty() {
            return Err(self.error(
                SearchDiagnosticKind::ExpectedExpression,
                SearchSpan { start: 0, end: 0 },
                "expected an expression",
            ));
        }

        let expression = self.parse_or()?;
        if let Some(token) = self.current() {
            return match token.kind {
                TokenKind::RightParenthesis => Err(self.error(
                    SearchDiagnosticKind::UnexpectedParenthesis,
                    token.span,
                    "unexpected closing parenthesis",
                )),
                TokenKind::Colon => Err(self.error(
                    SearchDiagnosticKind::UnexpectedColon,
                    token.span,
                    "unexpected `:`",
                )),
                _ => Err(self.error(
                    SearchDiagnosticKind::ExpectedExpression,
                    token.span,
                    "expected an expression",
                )),
            };
        }

        Ok(expression)
    }

    fn parse_or(&mut self) -> Result<SearchExpr, SearchQueryError> {
        let mut expression = self.parse_and()?;
        while matches!(self.current_kind(), Some(TokenKind::Pipe)) {
            let pipe_span = self.advance().span;
            if self.current().is_none()
                || matches!(
                    self.current_kind(),
                    Some(TokenKind::Pipe | TokenKind::RightParenthesis)
                )
            {
                return Err(self.error(
                    SearchDiagnosticKind::DanglingOr,
                    pipe_span,
                    "`|` must be followed by an expression",
                ));
            }
            let right = self.parse_and()?;
            expression = merge_any(expression, right);
        }
        Ok(expression)
    }

    fn parse_and(&mut self) -> Result<SearchExpr, SearchQueryError> {
        let mut expression = self.parse_unary()?;
        while matches!(
            self.current_kind(),
            Some(
                TokenKind::Word(_)
                    | TokenKind::Quoted(_)
                    | TokenKind::Minus
                    | TokenKind::LeftParenthesis
            )
        ) {
            let right = self.parse_unary()?;
            expression = merge_all(expression, right);
        }
        Ok(expression)
    }

    fn parse_unary(&mut self) -> Result<SearchExpr, SearchQueryError> {
        if matches!(self.current_kind(), Some(TokenKind::Minus)) {
            let minus_span = self.advance().span;
            if self.current().is_none()
                || matches!(
                    self.current_kind(),
                    Some(TokenKind::Pipe | TokenKind::RightParenthesis)
                )
            {
                return Err(self.error(
                    SearchDiagnosticKind::DanglingNot,
                    minus_span,
                    "`-` must be followed by an expression",
                ));
            }
            let child = self.parse_unary()?;
            let span = SearchSpan {
                start: minus_span.start,
                end: child.span().end,
            };
            return Ok(SearchExpr::Not {
                child: Box::new(child),
                span,
            });
        }

        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<SearchExpr, SearchQueryError> {
        let Some(token) = self.current().cloned() else {
            return Err(self.error(
                SearchDiagnosticKind::ExpectedExpression,
                SearchSpan {
                    start: self.input.len(),
                    end: self.input.len(),
                },
                "expected an expression",
            ));
        };

        match token.kind {
            TokenKind::LeftParenthesis => self.parse_group(),
            TokenKind::RightParenthesis => Err(self.error(
                SearchDiagnosticKind::UnexpectedParenthesis,
                token.span,
                "unexpected closing parenthesis",
            )),
            TokenKind::Colon => Err(self.error(
                SearchDiagnosticKind::UnexpectedColon,
                token.span,
                "unexpected `:`",
            )),
            TokenKind::Pipe => Err(self.error(
                SearchDiagnosticKind::ExpectedExpression,
                token.span,
                "expected an expression",
            )),
            TokenKind::Minus => unreachable!("minus tokens are parsed by parse_unary"),
            TokenKind::Quoted(value) => {
                self.advance();
                if value.is_empty() {
                    return Err(self.error(
                        SearchDiagnosticKind::EmptyValue,
                        token.span,
                        "value cannot be empty",
                    ));
                }
                Ok(SearchExpr::Text {
                    value,
                    mode: TextMode::Phrase,
                    span: token.span,
                })
            }
            TokenKind::Word(value) => {
                self.advance();
                if matches!(self.current_kind(), Some(TokenKind::Colon)) {
                    self.parse_field(value, token.span)
                } else {
                    Ok(SearchExpr::Text {
                        value,
                        mode: TextMode::Prefix,
                        span: token.span,
                    })
                }
            }
        }
    }

    fn parse_group(&mut self) -> Result<SearchExpr, SearchQueryError> {
        let opening_span = self.advance().span;
        if let Some(token) = self.current() {
            if matches!(token.kind, TokenKind::RightParenthesis) {
                let closing_span = self.advance().span;
                return Err(self.error(
                    SearchDiagnosticKind::EmptyGroup,
                    SearchSpan {
                        start: opening_span.start,
                        end: closing_span.end,
                    },
                    "empty parenthesized expression",
                ));
            }
        } else {
            return Err(self.error(
                SearchDiagnosticKind::UnmatchedParenthesis,
                opening_span,
                "unclosed parenthesis",
            ));
        }

        let mut expression = self.parse_or()?;
        let Some(closing) = self.current().cloned() else {
            return Err(self.error(
                SearchDiagnosticKind::UnmatchedParenthesis,
                opening_span,
                "unclosed parenthesis",
            ));
        };
        if !matches!(closing.kind, TokenKind::RightParenthesis) {
            return Err(self.error(
                SearchDiagnosticKind::UnmatchedParenthesis,
                opening_span,
                "unclosed parenthesis",
            ));
        }
        self.advance();
        expression.set_span(SearchSpan {
            start: opening_span.start,
            end: closing.span.end,
        });
        Ok(expression)
    }

    fn parse_field(
        &mut self,
        name: String,
        name_span: SearchSpan,
    ) -> Result<SearchExpr, SearchQueryError> {
        let field = match name.as_str() {
            "kind" => SearchField::Kind,
            "tag" => SearchField::Tag,
            "project" => SearchField::Project,
            _ => {
                return Err(self.error(
                    SearchDiagnosticKind::UnknownField,
                    name_span,
                    format_args!("unknown field `{name}`"),
                ));
            }
        };
        let colon_span = self.advance().span;
        let Some(value_token) = self.current().cloned() else {
            let end = colon_span.end;
            return Err(self.error(
                SearchDiagnosticKind::MissingFieldValue,
                SearchSpan { start: end, end },
                format_args!("missing value for field `{name}`"),
            ));
        };

        let value = match value_token.kind {
            TokenKind::Word(value) | TokenKind::Quoted(value) => value,
            _ => {
                return Err(self.error(
                    SearchDiagnosticKind::MissingFieldValue,
                    value_token.span,
                    format_args!("missing value for field `{name}`"),
                ));
            }
        };
        self.advance();

        if value.is_empty() {
            return Err(self.error(
                SearchDiagnosticKind::EmptyValue,
                value_token.span,
                "value cannot be empty",
            ));
        }

        let value = if field == SearchField::Kind {
            Kind::from_token(&value)
                .map(|kind| kind.as_str().to_owned())
                .ok_or_else(|| {
                    self.error(
                        SearchDiagnosticKind::UnknownKind,
                        value_token.span,
                        format_args!("unknown kind `{value}`"),
                    )
                })?
        } else {
            value
        };

        Ok(SearchExpr::Field {
            field,
            value,
            span: SearchSpan {
                start: name_span.start,
                end: value_token.span.end,
            },
        })
    }

    fn current(&self) -> Option<&Token> {
        self.tokens.get(self.position)
    }

    fn current_kind(&self) -> Option<&TokenKind> {
        self.current().map(|token| &token.kind)
    }

    fn advance(&mut self) -> Token {
        let token = self.tokens[self.position].clone();
        self.position += 1;
        token
    }

    fn error(
        &self,
        kind: SearchDiagnosticKind,
        span: SearchSpan,
        message: impl fmt::Display,
    ) -> SearchQueryError {
        SearchQueryError::new(self.input, kind, span, message)
    }
}

fn merge_all(left: SearchExpr, right: SearchExpr) -> SearchExpr {
    let span = SearchSpan {
        start: left.span().start,
        end: right.span().end,
    };
    let mut children = match left {
        SearchExpr::All { children, .. } => children,
        expression => vec![expression],
    };
    match right {
        SearchExpr::All {
            children: right_children,
            ..
        } => children.extend(right_children),
        expression => children.push(expression),
    }
    SearchExpr::All { children, span }
}

fn merge_any(left: SearchExpr, right: SearchExpr) -> SearchExpr {
    let span = SearchSpan {
        start: left.span().start,
        end: right.span().end,
    };
    let mut children = match left {
        SearchExpr::Any { children, .. } => children,
        expression => vec![expression],
    };
    match right {
        SearchExpr::Any {
            children: right_children,
            ..
        } => children.extend(right_children),
        expression => children.push(expression),
    }
    SearchExpr::Any { children, span }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(start: usize, end: usize) -> SearchSpan {
        SearchSpan { start, end }
    }

    fn text(value: &str, mode: TextMode, start: usize, end: usize) -> SearchExpr {
        SearchExpr::Text {
            value: value.to_owned(),
            mode,
            span: span(start, end),
        }
    }

    fn field(field: SearchField, value: &str, start: usize, end: usize) -> SearchExpr {
        SearchExpr::Field {
            field,
            value: value.to_owned(),
            span: span(start, end),
        }
    }

    fn all(children: Vec<SearchExpr>, start: usize, end: usize) -> SearchExpr {
        SearchExpr::All {
            children,
            span: span(start, end),
        }
    }

    fn any(children: Vec<SearchExpr>, start: usize, end: usize) -> SearchExpr {
        SearchExpr::Any {
            children,
            span: span(start, end),
        }
    }

    fn not(child: SearchExpr, start: usize, end: usize) -> SearchExpr {
        SearchExpr::Not {
            child: Box::new(child),
            span: span(start, end),
        }
    }

    #[test]
    fn parses_prefix_text() {
        assert_eq!(
            parse("clep").unwrap(),
            text("clep", TextMode::Prefix, 0, 4)
        );
    }

    #[test]
    fn parses_phrase_text() {
        assert_eq!(
            parse("\"local backup\"").unwrap(),
            text("local backup", TextMode::Phrase, 0, 14)
        );
    }

    #[test]
    fn parses_implicit_and_and_canonicalizes_kind() {
        assert_eq!(
            parse("kind:Recipe tag:dinner").unwrap(),
            all(
                vec![
                    field(SearchField::Kind, "RECIPE", 0, 11),
                    field(SearchField::Tag, "dinner", 12, 22),
                ],
                0,
                22,
            )
        );
    }

    #[test]
    fn parses_parenthesized_or_followed_by_text() {
        assert_eq!(
            parse("(tag:beer | tag:wine) tasting").unwrap(),
            all(
                vec![
                    any(
                        vec![
                            field(SearchField::Tag, "beer", 1, 9),
                            field(SearchField::Tag, "wine", 12, 20),
                        ],
                        0,
                        21,
                    ),
                    text("tasting", TextMode::Prefix, 22, 29),
                ],
                0,
                29,
            )
        );
    }

    #[test]
    fn applies_not_then_and_then_or_precedence() {
        assert_eq!(
            parse("kind:recipe -project:archive | tag:urgent").unwrap(),
            any(
                vec![
                    all(
                        vec![
                            field(SearchField::Kind, "RECIPE", 0, 11),
                            not(
                                field(SearchField::Project, "archive", 13, 28),
                                12,
                                28,
                            ),
                        ],
                        0,
                        28,
                    ),
                    field(SearchField::Tag, "urgent", 31, 41),
                ],
                0,
                41,
            )
        );
    }

    #[test]
    fn flattens_adjacent_and_and_or_expressions() {
        assert_eq!(
            parse("tag:a tag:b tag:c | tag:d | tag:e").unwrap(),
            any(
                vec![
                    all(
                        vec![
                            field(SearchField::Tag, "a", 0, 5),
                            field(SearchField::Tag, "b", 6, 11),
                            field(SearchField::Tag, "c", 12, 17),
                        ],
                        0,
                        17,
                    ),
                    field(SearchField::Tag, "d", 20, 25),
                    field(SearchField::Tag, "e", 28, 33),
                ],
                0,
                33,
            )
        );
    }

    #[test]
    fn not_binds_more_tightly_than_implicit_and() {
        assert_eq!(
            parse("-tag:a kind:note | tag:b").unwrap(),
            any(
                vec![
                    all(
                        vec![
                            not(field(SearchField::Tag, "a", 1, 6), 0, 6),
                            field(SearchField::Kind, "NOTE", 7, 16),
                        ],
                        0,
                        16,
                    ),
                    field(SearchField::Tag, "b", 19, 24),
                ],
                0,
                24,
            )
        );
    }

    #[test]
    fn parses_nested_parentheses_with_outer_spans() {
        assert_eq!(
            parse("(tag:a | (tag:b tag:c))").unwrap(),
            any(
                vec![
                    field(SearchField::Tag, "a", 1, 6),
                    all(
                        vec![
                            field(SearchField::Tag, "b", 10, 15),
                            field(SearchField::Tag, "c", 16, 21),
                        ],
                        9,
                        22,
                    ),
                ],
                0,
                23,
            )
        );
    }

    #[test]
    fn parses_quoted_and_escaped_field_values() {
        assert_eq!(
            parse("project:\"My Project\"").unwrap(),
            field(SearchField::Project, "My Project", 0, 20)
        );
        assert_eq!(
            parse(r#"tag:"say \"hi\" \\ now""#).unwrap(),
            field(SearchField::Tag, "say \"hi\" \\ now", 0, 23)
        );
    }

    #[test]
    fn distinguishes_hyphens_in_words_from_not() {
        assert_eq!(
            parse("ice-cream -ice").unwrap(),
            all(
                vec![
                    text("ice-cream", TextMode::Prefix, 0, 9),
                    not(text("ice", TextMode::Prefix, 11, 14), 10, 14),
                ],
                0,
                14,
            )
        );
    }

    #[test]
    fn reports_byte_spans_and_unicode_columns_separately() {
        let error = parse("é tag:").unwrap_err();
        assert_eq!(error.diagnostic.kind, SearchDiagnosticKind::MissingFieldValue);
        assert_eq!(error.diagnostic.span, span(7, 7));
        assert_eq!(error.diagnostic.column, 7);
        assert!(error.diagnostic.message.contains("at column 7"));
    }

    #[test]
    fn rejects_uppercase_field_keyword() {
        assert_diagnostic(
            "Kind:recipe",
            SearchDiagnosticKind::UnknownField,
            span(0, 4),
            "unknown field",
        );
    }

    #[test]
    fn rejects_unknown_kind() {
        assert_diagnostic(
            "kind:not-a-kind",
            SearchDiagnosticKind::UnknownKind,
            span(5, 15),
            "unknown kind",
        );
    }

    #[test]
    fn rejects_empty_quoted_values() {
        assert_diagnostic(
            "tag:\"\"",
            SearchDiagnosticKind::EmptyValue,
            span(4, 6),
            "cannot be empty",
        );
        assert_diagnostic(
            "\"\"",
            SearchDiagnosticKind::EmptyValue,
            span(0, 2),
            "cannot be empty",
        );
    }

    #[test]
    fn reports_each_malformed_query_kind() {
        let cases = [
            (
                "owner:kit",
                SearchDiagnosticKind::UnknownField,
                span(0, 5),
                "unknown field",
            ),
            (
                "tag:",
                SearchDiagnosticKind::MissingFieldValue,
                span(4, 4),
                "missing value",
            ),
            (
                "kind:not-a-kind",
                SearchDiagnosticKind::UnknownKind,
                span(5, 15),
                "unknown kind",
            ),
            (
                "\"unterminated",
                SearchDiagnosticKind::UnmatchedQuote,
                span(0, 13),
                "unterminated",
            ),
            (
                ")",
                SearchDiagnosticKind::UnexpectedParenthesis,
                span(0, 1),
                "unexpected",
            ),
            (
                "(tag:x",
                SearchDiagnosticKind::UnmatchedParenthesis,
                span(0, 1),
                "unclosed",
            ),
            (
                "tag:x |",
                SearchDiagnosticKind::DanglingOr,
                span(6, 7),
                "followed by an expression",
            ),
            (
                "-",
                SearchDiagnosticKind::DanglingNot,
                span(0, 1),
                "followed by an expression",
            ),
            (
                "()",
                SearchDiagnosticKind::EmptyGroup,
                span(0, 2),
                "empty",
            ),
            (
                "\"\"",
                SearchDiagnosticKind::EmptyValue,
                span(0, 2),
                "cannot be empty",
            ),
            (
                ":value",
                SearchDiagnosticKind::UnexpectedColon,
                span(0, 1),
                "unexpected",
            ),
            (
                "",
                SearchDiagnosticKind::ExpectedExpression,
                span(0, 0),
                "expected an expression",
            ),
        ];

        for (input, kind, expected_span, message) in cases {
            assert_diagnostic(input, kind, expected_span, message);
        }
    }

    fn assert_diagnostic(
        input: &str,
        kind: SearchDiagnosticKind,
        expected_span: SearchSpan,
        message_fragment: &str,
    ) {
        let error = parse(input).unwrap_err();
        assert_eq!(error.diagnostic.kind, kind, "input: {input:?}");
        assert_eq!(
            error.diagnostic.span, expected_span,
            "input: {input:?}"
        );
        assert!(
            error.diagnostic.message.contains(message_fragment),
            "input: {input:?}, message: {:?}",
            error.diagnostic.message
        );
        assert_eq!(
            error.diagnostic.message.matches("at column").count(),
            1,
            "input: {input:?}"
        );
    }
}
