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
        format!("Add :CFBundleIdentifier string {BUNDLE_ID}"),
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
    let home = dirs::home_dir().ok_or("cannot determine home directory")?;
    install_with(
        &home,
        binary,
        include_obsidian,
        |script, app_path| {
            let mut compile = Command::new("osacompile");
            compile.arg("-o").arg(app_path).arg(script);
            run_checked(compile, "osacompile")
        },
        |app_path, include_obsidian| {
            let plist = app_path.join("Contents/Info.plist");
            let _ = Command::new("/usr/libexec/PlistBuddy")
                .arg("-c")
                .arg("Delete :CFBundleIdentifier")
                .arg(&plist)
                .status();
            for command in plistbuddy_commands(include_obsidian) {
                let mut plistbuddy = Command::new("/usr/libexec/PlistBuddy");
                plistbuddy.arg("-c").arg(&command).arg(&plist);
                run_checked(plistbuddy, "PlistBuddy")?;
            }
            Ok(())
        },
        |app_path| {
            let mut register = Command::new(LSREGISTER);
            register.arg("-f").arg(app_path);
            run_checked(register, "lsregister")
        },
    )
}

fn install_with(
    home: &Path,
    binary: &Path,
    include_obsidian: bool,
    mut compile: impl FnMut(&Path, &Path) -> Result<(), Box<dyn std::error::Error>>,
    mut configure: impl FnMut(&Path, bool) -> Result<(), Box<dyn std::error::Error>>,
    mut register: impl FnMut(&Path) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let apps = home.join("Applications");
    std::fs::create_dir_all(&apps)?;
    let workspace = tempfile::Builder::new()
        .prefix(".clepsydra-url-handler-")
        .tempdir_in(&apps)?;
    let staged = workspace.path().join(APP_NAME);
    let backup = workspace.path().join("previous.app");
    let app_path = apps.join(APP_NAME);

    let mut script = tempfile::Builder::new().suffix(".applescript").tempfile()?;
    script.write_all(applescript_source(binary).as_bytes())?;
    script.flush()?;
    compile(script.path(), &staged)?;
    configure(&staged, include_obsidian)?;

    let had_previous = app_path.exists();
    if had_previous {
        std::fs::rename(&app_path, &backup)?;
    }
    if let Err(error) = std::fs::rename(&staged, &app_path) {
        if had_previous && let Err(restore) = std::fs::rename(&backup, &app_path) {
            let preserved = workspace.keep();
            return Err(format!(
                "publish URL handler failed: {error}; restoring previous bundle failed: \
                 {restore}; rollback workspace preserved at {}",
                preserved.display()
            )
            .into());
        }
        return Err(error.into());
    }

    if let Err(primary) = register(&app_path) {
        let mut compensation_failures = Vec::new();
        if let Err(error) = std::fs::remove_dir_all(&app_path) {
            compensation_failures.push(format!("remove replacement: {error}"));
        }
        if had_previous {
            match std::fs::rename(&backup, &app_path) {
                Ok(()) => {
                    if let Err(error) = register(&app_path) {
                        compensation_failures.push(format!("re-register previous bundle: {error}"));
                    }
                }
                Err(error) => {
                    compensation_failures.push(format!("restore previous bundle: {error}"));
                }
            }
        }
        if compensation_failures.is_empty() {
            return Err(primary);
        }
        let preserved = workspace.keep();
        return Err(format!(
            "{primary}; URL handler compensation failed: {}; rollback workspace preserved at {}",
            compensation_failures.join("; "),
            preserved.display()
        )
        .into());
    }

    Ok(app_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn registration_failure_restores_previous_bundle() {
        let home = tempfile::tempdir().unwrap();
        let app = home.path().join("Applications").join(APP_NAME);
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("identity"), b"previous").unwrap();
        let registration_attempts = Cell::new(0);

        let error = install_with(
            home.path(),
            Path::new("/usr/local/bin/clepsydra"),
            false,
            |_, staging| {
                std::fs::create_dir_all(staging.join("Contents"))?;
                std::fs::write(staging.join("identity"), b"replacement")?;
                std::fs::write(staging.join("Contents/Info.plist"), b"plist")?;
                Ok(())
            },
            |_, _| Ok(()),
            |candidate| {
                registration_attempts.set(registration_attempts.get() + 1);
                if std::fs::read(candidate.join("identity"))? == b"replacement" {
                    Err("injected Launch Services registration failure".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("injected Launch Services registration failure")
        );
        assert_eq!(std::fs::read(app.join("identity")).unwrap(), b"previous");
        assert_eq!(
            registration_attempts.get(),
            2,
            "the restored previous bundle must be re-registered"
        );
    }

    #[test]
    fn restore_failure_preserves_previous_bundle_in_rollback_workspace() {
        let home = tempfile::tempdir().unwrap();
        let applications = home.path().join("Applications");
        let app = applications.join(APP_NAME);
        std::fs::create_dir_all(&app).unwrap();
        std::fs::write(app.join("identity"), b"previous").unwrap();

        let error = install_with(
            home.path(),
            Path::new("/usr/local/bin/clepsydra"),
            false,
            |_, staging| {
                std::fs::create_dir_all(staging.join("Contents"))?;
                std::fs::write(staging.join("identity"), b"replacement")?;
                std::fs::write(staging.join("Contents/Info.plist"), b"plist")?;
                Ok(())
            },
            |_, _| Ok(()),
            |candidate| {
                std::fs::remove_dir_all(candidate)?;
                std::fs::write(candidate, b"blocks restoration")?;
                Err("injected Launch Services registration failure".into())
            },
        )
        .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("injected Launch Services registration failure"));
        assert!(message.contains("remove replacement"));
        assert!(message.contains("restore previous bundle"));
        let rollback_workspaces: Vec<_> = std::fs::read_dir(&applications)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".clepsydra-url-handler-"))
            })
            .collect();
        assert_eq!(
            rollback_workspaces.len(),
            1,
            "the rollback workspace must survive compensation failure"
        );
        assert!(
            message.contains(&rollback_workspaces[0].display().to_string()),
            "the error must report the preserved rollback path: {message}"
        );
        assert_eq!(
            std::fs::read(rollback_workspaces[0].join("previous.app/identity")).unwrap(),
            b"previous"
        );
    }
}
