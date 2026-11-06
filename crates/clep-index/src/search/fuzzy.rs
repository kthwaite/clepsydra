use std::cell::RefCell;

use rusqlite::{Connection, functions::FunctionFlags, types::ValueRef};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

/// SQL evaluates this predicate before Boolean composition, ordering and LIMIT.
/// Query terms are cached by SQLite; scratch buffers are reused across rows.
pub(super) fn register(connection: &Connection) -> rusqlite::Result<()> {
    let scratch = RefCell::new(Scratch::default());
    connection.create_scalar_function(
        "clep_fuzzy_title",
        2,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        move |context| {
            let terms =
                context.get_or_create_aux(0, |value| -> rusqlite::Result<Vec<Vec<char>>> {
                    let normalized: String = normalize(value.as_str()?).collect();
                    Ok(words(&normalized)
                        .map(|word| word.chars().collect())
                        .collect())
                })?;
            let title = match context.get_raw(1) {
                ValueRef::Null => return Ok(false),
                value => value.as_str()?,
            };
            Ok(scratch.borrow_mut().matches(&terms, title))
        },
    )
}

fn normalize(value: &str) -> impl Iterator<Item = char> + '_ {
    value
        .nfd()
        .filter(|character| !is_combining_mark(*character))
        .flat_map(char::to_lowercase)
}

fn words(value: &str) -> impl Iterator<Item = &str> {
    value
        .split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
}

#[derive(Default)]
struct Scratch {
    title: String,
    word: Vec<char>,
    rows: [Vec<usize>; 3],
}

impl Scratch {
    fn matches(&mut self, terms: &[Vec<char>], title: &str) -> bool {
        if terms.is_empty() {
            return false;
        }
        self.title.clear();
        self.title.extend(normalize(title));
        terms.iter().all(|term| {
            let budget = match term.len() {
                0..=3 => 0,
                4..=7 => 1,
                _ => 2,
            };
            words(&self.title).any(|word| {
                self.word.clear();
                self.word.extend(word.chars());
                self.word.starts_with(term)
                    || (budget > 0 && within_distance(term, &self.word, budget, &mut self.rows))
            })
        })
    }
}

/// Banded optimal-string-alignment distance: insertion, deletion, substitution,
/// or one adjacent transposition. Length rejection and a band of at most five
/// cells per row bound work for long titles and queries.
fn within_distance(
    query: &[char],
    word: &[char],
    budget: usize,
    rows: &mut [Vec<usize>; 3],
) -> bool {
    if query.len().abs_diff(word.len()) > budget {
        return false;
    }
    let outside = budget + 1;
    for row in rows.iter_mut() {
        row.resize(word.len() + 1, outside);
    }
    for (column, cell) in rows[0].iter_mut().take(budget + 1).enumerate() {
        *cell = column;
    }
    if word.len() > budget {
        rows[0][budget + 1] = outside;
    }
    for i in 1..=query.len() {
        let current = i % 3;
        let previous = (i - 1) % 3;
        let start = i.saturating_sub(budget).max(1);
        let end = (i + budget).min(word.len());
        rows[current][0] = i.min(outside);
        if start > 1 {
            rows[current][start - 1] = outside;
        }
        if end < word.len() {
            rows[current][end + 1] = outside;
        }
        for j in start..=end {
            let substitution = rows[previous][j - 1] + usize::from(query[i - 1] != word[j - 1]);
            let mut distance = substitution
                .min(rows[previous][j] + 1)
                .min(rows[current][j - 1] + 1);
            if i > 1 && j > 1 && query[i - 1] == word[j - 2] && query[i - 2] == word[j - 1] {
                distance = distance.min(rows[(i - 2) % 3][j - 2] + 1);
            }
            rows[current][j] = distance.min(outside);
        }
    }
    rows[query.len() % 3][word.len()] <= budget
}
