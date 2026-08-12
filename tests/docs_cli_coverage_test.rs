use std::{collections::BTreeSet, process::Command};

fn help_for(path: &[String]) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_clep"))
        .args(path)
        .arg("--help")
        .output()
        .unwrap_or_else(|error| panic!("failed to execute help for {path:?}: {error}"));

    assert!(
        output.status.success(),
        "help for {path:?} exited with {}\nstdout:\n{}\nstderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout)
        .unwrap_or_else(|error| panic!("help for {path:?} was not UTF-8: {error}"))
}
fn executable_name(help: &str) -> &str {
    help.lines()
        .find_map(|line| line.strip_prefix("Usage: "))
        .and_then(|usage| usage.split_whitespace().next())
        .expect("root help should contain a Usage line")
}


fn command_names(help: &str) -> Vec<String> {
    let mut in_commands = false;
    let mut names = Vec::new();

    for line in help.lines() {
        if line == "Commands:" {
            in_commands = true;
            continue;
        }
        if !in_commands {
            continue;
        }
        if line.is_empty() {
            break;
        }
        if !line.starts_with("  ") {
            break;
        }

        let Some(name) = line.split_whitespace().next() else {
            continue;
        };
        if name != "help" && !name.starts_with('-') {
            names.push(name.to_owned());
        }
    }

    names
}

fn public_commands_from_help() -> BTreeSet<String> {
    let root_help = help_for(&[]);
    let executable = executable_name(&root_help);
    let mut commands = BTreeSet::new();
    let mut pending = vec![Vec::<String>::new()];

    while let Some(parent) = pending.pop() {
        let help = if parent.is_empty() {
            root_help.clone()
        } else {
            help_for(&parent)
        };
        for name in command_names(&help) {
            let mut path = parent.clone();
            path.push(name);
            let canonical = format!("{executable} {}", path.join(" "));
            if commands.insert(canonical) {
                pending.push(path);
            }
        }
    }

    commands
}

fn missing_command_headings(commands: &BTreeSet<String>, docs: &str) -> Vec<String> {
    commands
        .iter()
        .filter(|command| !docs.lines().any(|line| line == format!("## `{command}`")))
        .cloned()
        .collect()
}

#[test]
fn every_public_cli_command_is_documented() {
    let commands = public_commands_from_help();
    let docs = std::fs::read_to_string("ui/src/docs/content/cli.mdx")
        .expect("CLI reference should be readable");
    let missing = missing_command_headings(&commands, &docs);

    assert!(
        missing.is_empty(),
        "{} of {} public CLI command paths lack canonical headings:\n{}",
        missing.len(),
        commands.len(),
        missing.join("\n"),
    );
}

#[test]
fn help_extraction_recurses_into_nested_commands_without_treating_options_as_commands() {
    let commands = public_commands_from_help();

    assert!(commands.contains("clep config show"));
    assert!(commands.contains("clep config path"));
    assert!(commands.contains("clep config create"));
    assert!(commands.iter().all(|command| !command.contains(" --")));
}

#[test]
fn unknown_subcommand_exits_with_clap_usage_status() {
    let output = Command::new(env!("CARGO_BIN_EXE_clep"))
        .arg("not-a-command")
        .output()
        .expect("CLI should execute");
    let stderr = String::from_utf8(output.stderr).expect("Clap stderr should be UTF-8");

    assert_eq!(output.status.code(), Some(2));
    assert!(stderr.contains("unrecognized subcommand 'not-a-command'"));
    assert!(stderr.contains("Usage: clep <COMMAND>"));
}
