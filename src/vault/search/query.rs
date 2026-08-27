use std::{collections::VecDeque, fmt};

use crate::vault::kind::Kind;

const MAX_QUERY_BYTES: usize = 4096;
const MAX_NESTING_DEPTH: usize = 32;
const MAX_AST_NODES: usize = 128;
const MAX_POSITIVE_TEXT_LEAVES: usize = 64;

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
    QueryTooComplex,
}

impl SearchDiagnosticKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UnknownField => "unknown_field",
            Self::MissingFieldValue => "missing_field_value",
            Self::UnknownKind => "unknown_kind",
            Self::UnmatchedQuote => "unmatched_quote",
            Self::UnexpectedParenthesis => "unexpected_parenthesis",
            Self::UnmatchedParenthesis => "unmatched_parenthesis",
            Self::DanglingOr => "dangling_or",
            Self::DanglingNot => "dangling_not",
            Self::EmptyGroup => "empty_group",
            Self::EmptyValue => "empty_value",
            Self::UnexpectedColon => "unexpected_colon",
            Self::QueryTooComplex => "query_too_complex",
            Self::ExpectedExpression => "expected_expression",
        }
    }
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
    pub fn diagnostic(&self) -> &SearchDiagnostic {
        &self.diagnostic
    }

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

#[derive(Debug, PartialEq, Eq)]
enum TokenKind {
    Word(String),
    Quoted(String),
    Colon,
    Pipe,
    Minus,
    LeftParenthesis,
    RightParenthesis,
}

#[derive(Debug, PartialEq, Eq)]
struct Token {
    kind: TokenKind,
    span: SearchSpan,
}

pub(super) fn parse(input: &str) -> Result<SearchExpr, SearchQueryError> {
    if input.len() > MAX_QUERY_BYTES {
        let (start, character) = input
            .char_indices()
            .find(|(start, character)| start + character.len_utf8() > MAX_QUERY_BYTES)
            .expect("an over-limit input has a character crossing the byte limit");
        return Err(SearchQueryError::new(
            input,
            SearchDiagnosticKind::QueryTooComplex,
            SearchSpan {
                start,
                end: start + character.len_utf8(),
            },
            format_args!("search query exceeds {MAX_QUERY_BYTES}-byte limit"),
        ));
    }

    let tokens = lex(input)?;
    validate_nesting(input, &tokens)?;
    let expression = Parser { input, tokens }.parse()?;
    validate_expression(input, &expression)?;
    Ok(expression)
}

fn validate_nesting(
    input: &str,
    tokens: &VecDeque<Token>,
) -> Result<(), SearchQueryError> {
    let mut depth = 0usize;
    let mut pending_nots = 0usize;
    let mut group_contributions = Vec::new();

    for token in tokens {
        match token.kind {
            TokenKind::Minus => {
                pending_nots += 1;
                ensure_nesting_depth(input, token.span, depth + pending_nots)?;
            }
            TokenKind::LeftParenthesis => {
                let contribution = pending_nots + 1;
                depth += contribution;
                ensure_nesting_depth(input, token.span, depth)?;
                group_contributions.push(contribution);
                pending_nots = 0;
            }
            TokenKind::RightParenthesis => {
                pending_nots = 0;
                if let Some(contribution) = group_contributions.pop() {
                    depth -= contribution;
                }
            }
            TokenKind::Word(_) | TokenKind::Quoted(_) => {
                ensure_nesting_depth(input, token.span, depth + pending_nots)?;
                pending_nots = 0;
            }
            TokenKind::Colon | TokenKind::Pipe => {
                pending_nots = 0;
            }
        }
    }

    Ok(())
}

fn ensure_nesting_depth(
    input: &str,
    span: SearchSpan,
    depth: usize,
) -> Result<(), SearchQueryError> {
    if depth <= MAX_NESTING_DEPTH {
        return Ok(());
    }
    Err(SearchQueryError::new(
        input,
        SearchDiagnosticKind::QueryTooComplex,
        span,
        format_args!("search query exceeds nesting depth limit of {MAX_NESTING_DEPTH}"),
    ))
}

fn validate_expression(input: &str, expression: &SearchExpr) -> Result<(), SearchQueryError> {
    let mut stack = vec![(expression, false)];
    let mut nodes = 0usize;
    let mut positive_text_leaves = 0usize;

    while let Some((expression, negated)) = stack.pop() {
        nodes += 1;
        if nodes > MAX_AST_NODES {
            return Err(SearchQueryError::new(
                input,
                SearchDiagnosticKind::QueryTooComplex,
                expression.span(),
                format_args!("search query exceeds AST node limit of {MAX_AST_NODES}"),
            ));
        }

        match expression {
            SearchExpr::Text { span, .. } => {
                if !negated {
                    positive_text_leaves += 1;
                    if positive_text_leaves > MAX_POSITIVE_TEXT_LEAVES {
                        return Err(SearchQueryError::new(
                            input,
                            SearchDiagnosticKind::QueryTooComplex,
                            *span,
                            format_args!(
                                "search query exceeds positive text leaf limit of \
                                 {MAX_POSITIVE_TEXT_LEAVES}"
                            ),
                        ));
                    }
                }
            }
            SearchExpr::Field { .. } => {}
            SearchExpr::All { children, .. } | SearchExpr::Any { children, .. } => {
                stack.extend(children.iter().rev().map(|child| (child, negated)));
            }
            SearchExpr::Not { child, .. } => stack.push((child, !negated)),
        }
    }

    Ok(())
}

fn lex(input: &str) -> Result<VecDeque<Token>, SearchQueryError> {
    let mut tokens = VecDeque::new();
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
        tokens.push_back(token);
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
    tokens: VecDeque<Token>,
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
            let next_span = self
                .current()
                .expect("the loop condition requires a current token")
                .span;
            let previous_end = expression.span().end;
            if !self.input[previous_end..next_span.start]
                .chars()
                .any(char::is_whitespace)
            {
                return Err(self.error(
                    SearchDiagnosticKind::ExpectedExpression,
                    next_span,
                    "implicit AND requires whitespace",
                ));
            }
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
        if self.current().is_none() {
            return Err(self.error(
                SearchDiagnosticKind::ExpectedExpression,
                SearchSpan {
                    start: self.input.len(),
                    end: self.input.len(),
                },
                "expected an expression",
            ));
        }
        let token = self.advance();

        match token.kind {
            TokenKind::LeftParenthesis => self.parse_group(token.span),
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
                SearchDiagnosticKind::DanglingOr,
                token.span,
                "`|` must follow an expression",
            )),
            TokenKind::Minus => unreachable!("minus tokens are parsed by parse_unary"),
            TokenKind::Quoted(value) => {
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

    fn parse_group(
        &mut self,
        opening_span: SearchSpan,
    ) -> Result<SearchExpr, SearchQueryError> {
        if matches!(self.current_kind(), Some(TokenKind::RightParenthesis)) {
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
        if self.current().is_none() {
            return Err(self.error(
                SearchDiagnosticKind::UnmatchedParenthesis,
                opening_span,
                "unclosed parenthesis",
            ));
        }

        let mut expression = self.parse_or()?;
        let closing_span = match self.current() {
            Some(Token {
                kind: TokenKind::RightParenthesis,
                span,
            }) => *span,
            Some(_) | None => {
                return Err(self.error(
                    SearchDiagnosticKind::UnmatchedParenthesis,
                    opening_span,
                    "unclosed parenthesis",
                ));
            }
        };
        self.advance();
        expression.set_span(SearchSpan {
            start: opening_span.start,
            end: closing_span.end,
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
                    format_args!("unknown search field '{name}'"),
                ));
            }
        };
        let colon_span = self.advance().span;
        let Some(current) = self.current() else {
            let end = colon_span.end;
            return Err(self.error(
                SearchDiagnosticKind::MissingFieldValue,
                SearchSpan { start: end, end },
                format_args!("missing value for field `{name}`"),
            ));
        };
        let value_span = current.span;
        if !matches!(
            current.kind,
            TokenKind::Word(_) | TokenKind::Quoted(_)
        ) {
            return Err(self.error(
                SearchDiagnosticKind::MissingFieldValue,
                value_span,
                format_args!("missing value for field `{name}`"),
            ));
        }

        let value = match self.advance().kind {
            TokenKind::Word(value) | TokenKind::Quoted(value) => value,
            _ => unreachable!("the current token was validated as a field value"),
        };
        if value.is_empty() {
            return Err(self.error(
                SearchDiagnosticKind::EmptyValue,
                value_span,
                "value cannot be empty",
            ));
        }

        let value = if field == SearchField::Kind {
            Kind::from_token(&value)
                .map(|kind| kind.as_str().to_owned())
                .ok_or_else(|| {
                    self.error(
                        SearchDiagnosticKind::UnknownKind,
                        value_span,
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
                end: value_span.end,
            },
        })
    }

    fn current(&self) -> Option<&Token> {
        self.tokens.front()
    }

    fn current_kind(&self) -> Option<&TokenKind> {
        self.current().map(|token| &token.kind)
    }

    fn advance(&mut self) -> Token {
        self.tokens
            .pop_front()
            .expect("the parser only advances when a current token exists")
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
    fn rejects_word_and_quote_adjacency_without_whitespace() {
        assert_diagnostic(
            "foo\"bar\"",
            SearchDiagnosticKind::ExpectedExpression,
            span(3, 8),
            "implicit AND requires whitespace",
        );
    }

    #[test]
    fn rejects_parenthesis_adjacency_without_whitespace() {
        assert_diagnostic(
            "foo(bar)",
            SearchDiagnosticKind::ExpectedExpression,
            span(3, 4),
            "implicit AND requires whitespace",
        );
        assert_diagnostic(
            "(foo)(bar)",
            SearchDiagnosticKind::ExpectedExpression,
            span(5, 6),
            "implicit AND requires whitespace",
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
            "unknown search field",
        );
    }

    #[test]
    fn exposes_stable_public_diagnostic_contract() {
        let error = parse("knd:recipe").unwrap_err();
        assert_eq!(
            error.diagnostic().kind,
            SearchDiagnosticKind::UnknownField
        );
        assert_eq!(error.diagnostic().span, span(0, 3));
        assert_eq!(error.diagnostic().column, 1);
        assert_eq!(
            error.diagnostic().message,
            "unknown search field 'knd' at column 1"
        );
        assert_eq!(
            error.to_string(),
            "unknown search field 'knd' at column 1"
        );

        let kinds = [
            (SearchDiagnosticKind::UnknownField, "unknown_field"),
            (
                SearchDiagnosticKind::MissingFieldValue,
                "missing_field_value",
            ),
            (SearchDiagnosticKind::UnknownKind, "unknown_kind"),
            (SearchDiagnosticKind::UnmatchedQuote, "unmatched_quote"),
            (
                SearchDiagnosticKind::UnexpectedParenthesis,
                "unexpected_parenthesis",
            ),
            (
                SearchDiagnosticKind::UnmatchedParenthesis,
                "unmatched_parenthesis",
            ),
            (SearchDiagnosticKind::DanglingOr, "dangling_or"),
            (
                SearchDiagnosticKind::QueryTooComplex,
                "query_too_complex",
            ),
            (SearchDiagnosticKind::DanglingNot, "dangling_not"),
            (SearchDiagnosticKind::EmptyGroup, "empty_group"),
            (SearchDiagnosticKind::EmptyValue, "empty_value"),
            (SearchDiagnosticKind::UnexpectedColon, "unexpected_colon"),
            (
                SearchDiagnosticKind::ExpectedExpression,
                "expected_expression",
            ),
        ];
        for (kind, token) in kinds {
            assert_eq!(kind.as_str(), token);
        }
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
                "unknown search field",
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
                "| tag:x",
                SearchDiagnosticKind::DanglingOr,
                span(0, 1),
                "`|`",
            ),
            (
                "|",
                SearchDiagnosticKind::DanglingOr,
                span(0, 1),
                "`|`",
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

    #[test]
    fn enforces_exact_query_complexity_boundaries() {
        let maximum_bytes = "a".repeat(MAX_QUERY_BYTES);
        assert!(parse(&maximum_bytes).is_ok());
        let too_many_bytes = "a".repeat(MAX_QUERY_BYTES + 1);
        assert_diagnostic(
            &too_many_bytes,
            SearchDiagnosticKind::QueryTooComplex,
            span(MAX_QUERY_BYTES, MAX_QUERY_BYTES + 1),
            "4096-byte limit",
        );

        let maximum_groups = format!(
            "{}a{}",
            "(".repeat(MAX_NESTING_DEPTH),
            ")".repeat(MAX_NESTING_DEPTH)
        );
        assert!(parse(&maximum_groups).is_ok());
        let too_many_groups = format!(
            "{}a{}",
            "(".repeat(MAX_NESTING_DEPTH + 1),
            ")".repeat(MAX_NESTING_DEPTH + 1)
        );
        assert_diagnostic(
            &too_many_groups,
            SearchDiagnosticKind::QueryTooComplex,
            span(MAX_NESTING_DEPTH, MAX_NESTING_DEPTH + 1),
            "nesting depth",
        );

        let maximum_nots = format!("{}a", "-".repeat(MAX_NESTING_DEPTH));
        assert!(parse(&maximum_nots).is_ok());
        let too_many_nots = format!("{}a", "-".repeat(MAX_NESTING_DEPTH + 1));
        assert_diagnostic(
            &too_many_nots,
            SearchDiagnosticKind::QueryTooComplex,
            span(MAX_NESTING_DEPTH, MAX_NESTING_DEPTH + 1),
            "nesting depth",
        );

        let maximum_nodes = std::iter::repeat_n("tag:x", MAX_AST_NODES - 1)
            .collect::<Vec<_>>()
            .join(" ");
        assert!(parse(&maximum_nodes).is_ok());
        let too_many_nodes = std::iter::repeat_n("tag:x", MAX_AST_NODES)
            .collect::<Vec<_>>()
            .join(" ");
        let final_node_start = too_many_nodes.rfind("tag:x").unwrap();
        assert_diagnostic(
            &too_many_nodes,
            SearchDiagnosticKind::QueryTooComplex,
            span(final_node_start, final_node_start + "tag:x".len()),
            "AST node limit",
        );

        let maximum_positive_text =
            std::iter::repeat_n("a", MAX_POSITIVE_TEXT_LEAVES)
                .collect::<Vec<_>>()
                .join(" | ");
        assert!(parse(&maximum_positive_text).is_ok());
        let too_many_positive_text =
            std::iter::repeat_n("a", MAX_POSITIVE_TEXT_LEAVES + 1)
                .collect::<Vec<_>>()
                .join(" | ");
        let final_text_start = too_many_positive_text.rfind('a').unwrap();
        assert_diagnostic(
            &too_many_positive_text,
            SearchDiagnosticKind::QueryTooComplex,
            span(final_text_start, final_text_start + 1),
            "positive text leaf limit",
        );
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
