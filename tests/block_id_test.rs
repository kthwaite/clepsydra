use clepsydra::vault::block_id::BlockId;

#[test]
fn generates_valid_block_id() {
    let id = BlockId::generate();
    let s = id.as_str();
    assert!(
        (10..=12).contains(&s.len()),
        "expected length 10-12, got {} for {:?}",
        s.len(),
        s
    );
    assert!(
        s.chars().all(|c| c.is_ascii_alphanumeric()),
        "expected all alphanumeric, got {:?}",
        s
    );
}

#[test]
fn ids_are_time_sorted() {
    let id1 = BlockId::generate();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let id2 = BlockId::generate();

    assert!(
        id1.as_str() < id2.as_str(),
        "expected {:?} < {:?} (chronological = lexicographic)",
        id1.as_str(),
        id2.as_str()
    );
}

#[test]
fn parse_round_trips() {
    let id = BlockId::generate();
    let s = id.to_string();
    let parsed = BlockId::parse(&s).expect("round-trip parse should succeed");
    assert_eq!(parsed.to_string(), s);
}

#[test]
fn parse_rejects_invalid() {
    // Empty string
    assert!(
        BlockId::parse("").is_none(),
        "empty string should be rejected"
    );

    // Too short (9 chars)
    assert!(
        BlockId::parse("abcdefghi").is_none(),
        "9 chars should be rejected"
    );

    // Too long (13 chars)
    assert!(
        BlockId::parse("abcdefghijklm").is_none(),
        "13 chars should be rejected"
    );

    // Special characters
    assert!(
        BlockId::parse("abc!defghij").is_none(),
        "special chars should be rejected"
    );

    // Spaces
    assert!(
        BlockId::parse("abc defghij").is_none(),
        "spaces should be rejected"
    );
}

#[test]
fn display_matches_as_str() {
    let id = BlockId::generate();
    assert_eq!(format!("{id}"), id.as_str());
}

#[test]
fn ord_is_consistent_with_time_sorting() {
    let id1 = BlockId::generate();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let id2 = BlockId::generate();

    // Ord on BlockId should agree with string comparison since the inner
    // derive(Ord) on a single-field String struct uses String::cmp.
    assert!(id1 < id2, "Ord should match lexicographic ordering");
}

#[test]
fn parse_accepts_boundary_lengths() {
    // 10 chars — minimum valid
    assert!(BlockId::parse("abcdefghij").is_some());

    // 11 chars — standard generated length
    assert!(BlockId::parse("abcdefghijk").is_some());

    // 12 chars — maximum valid
    assert!(BlockId::parse("abcdefghijkl").is_some());
}
