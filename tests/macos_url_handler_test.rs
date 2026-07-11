use std::path::Path;

use clepsydra::macos_url_handler::{applescript_source, plistbuddy_commands};

#[test]
fn applescript_invokes_the_binary_with_open_url() {
    let src = applescript_source(Path::new("/usr/local/bin/clepsydra"));
    assert_eq!(
        src,
        "on open location theURL\n\tdo shell script \"\\\"/usr/local/bin/clepsydra\\\" open-url \" & quoted form of theURL\nend open location\n"
    );
}

#[test]
fn plist_commands_register_clepsydra_scheme() {
    let cmds = plistbuddy_commands(false);
    assert!(
        cmds.iter()
            .any(|c| c == "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string clepsydra")
    );
    assert!(cmds.iter().all(|c| !c.contains("string obsidian")));
    assert!(
        cmds.iter()
            .any(|c| c == "Add :CFBundleIdentifier string md.clepsydra.url-handler")
    );
}

#[test]
fn plist_commands_add_obsidian_scheme_only_when_flagged() {
    let cmds = plistbuddy_commands(true);
    assert!(
        cmds.iter()
            .any(|c| c == "Add :CFBundleURLTypes:1:CFBundleURLSchemes:0 string obsidian")
    );
}
