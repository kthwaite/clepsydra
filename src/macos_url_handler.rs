//! Generation and installation of the macOS URL-handler applet.
//!
//! Launch Services only routes custom schemes to an app bundle declaring
//! `CFBundleURLTypes`, and delivers the URL via an Apple Event that a plain
//! CLI binary cannot receive. The smallest bridge is a compiled AppleScript
//! applet whose `open location` handler shells back into `clepsydra open-url`.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const APP_NAME: &str = "Clepsydra URL Handler.app";
const BUNDLE_ID: &str = "md.clepsydra.url-handler";
const LSREGISTER: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/// AppleScript source for the applet. The binary path is embedded inside an
/// AppleScript string literal, so its quotes are escaped for that context;
/// the user-controlled URL goes through `quoted form of` instead.
pub fn applescript_source(binary: &Path) -> String {
    format!(
        "on open location theURL\n\tdo shell script \"\\\"{}\\\" open-url \" & quoted form of theURL\nend open location\n",
        binary.display()
    )
}

/// PlistBuddy commands that declare the URL schemes on the applet's
/// Info.plist. Index 1 (obsidian) exists only when compat is requested.
pub fn plistbuddy_commands(include_obsidian: bool) -> Vec<String> {
    let mut cmds = vec![
        format!("Set :CFBundleIdentifier {BUNDLE_ID}"),
        "Add :CFBundleURLTypes array".to_string(),
        "Add :CFBundleURLTypes:0 dict".to_string(),
        "Add :CFBundleURLTypes:0:CFBundleURLName string Clepsydra deep link".to_string(),
        "Add :CFBundleURLTypes:0:CFBundleURLSchemes array".to_string(),
        "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string clepsydra".to_string(),
    ];
    if include_obsidian {
        cmds.extend([
            "Add :CFBundleURLTypes:1 dict".to_string(),
            "Add :CFBundleURLTypes:1:CFBundleURLName string Obsidian compat link".to_string(),
            "Add :CFBundleURLTypes:1:CFBundleURLSchemes array".to_string(),
            "Add :CFBundleURLTypes:1:CFBundleURLSchemes:0 string obsidian".to_string(),
        ]);
    }
    cmds
}

fn run_checked(mut cmd: Command, what: &str) -> Result<(), Box<dyn std::error::Error>> {
    let status = cmd.status()?;
    if !status.success() {
        return Err(format!("{what} failed with {status}").into());
    }
    Ok(())
}

/// Compile and install the applet into `~/Applications`, replacing any
/// previous installation, then force a Launch Services re-registration.
pub fn install(
    binary: &Path,
    include_obsidian: bool,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let apps = dirs::home_dir()
        .ok_or("cannot determine home directory")?
        .join("Applications");
    std::fs::create_dir_all(&apps)?;
    let app_path = apps.join(APP_NAME);
    if app_path.exists() {
        std::fs::remove_dir_all(&app_path)?;
    }

    let mut script = tempfile::Builder::new().suffix(".applescript").tempfile()?;
    script.write_all(applescript_source(binary).as_bytes())?;
    script.flush()?;

    let mut compile = Command::new("osacompile");
    compile.arg("-o").arg(&app_path).arg(script.path());
    run_checked(compile, "osacompile")?;

    let plist = app_path.join("Contents/Info.plist");
    for cmd in plistbuddy_commands(include_obsidian) {
        let mut pb = Command::new("/usr/libexec/PlistBuddy");
        pb.arg("-c").arg(&cmd).arg(&plist);
        run_checked(pb, "PlistBuddy")?;
    }

    let mut reg = Command::new(LSREGISTER);
    reg.arg("-f").arg(&app_path);
    run_checked(reg, "lsregister")?;

    Ok(app_path)
}
