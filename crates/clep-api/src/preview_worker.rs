//! Explicit, versioned provisioning for the native screenshot worker.
//!
//! Lookup never invokes Node or npm. Each successful install activates a new immutable
//! generation; an interrupted reinstall leaves the previous generation usable.

use std::{
    ffi::OsStr,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::Stdio,
};

use serde::{Deserialize, Serialize};
use tokio::process::Command;

const ASSETS: [(&str, &[u8]); 5] = [
    (
        "worker.mjs",
        include_bytes!("../../../preview-worker/worker.mjs"),
    ),
    (
        "supervisor.mjs",
        include_bytes!("../../../preview-worker/supervisor.mjs"),
    ),
    (
        "package.json",
        include_bytes!("../../../preview-worker/package.json"),
    ),
    (
        "package-lock.json",
        include_bytes!("../../../preview-worker/package-lock.json"),
    ),
    (
        "browser-process.mjs",
        include_bytes!("../../../preview-worker/browser-process.mjs"),
    ),
];

// Verify the full Chromium can actually start with its sandbox before activation,
// not merely that npm downloaded an executable. Lookup never runs this probe.
const PROBE: &str = r#"
const { chromium } = require('playwright-core');
require('ws'); // The authenticated runtime bridge must also be fully installed.
const fs = require('node:fs');
const executable = chromium.executablePath();
if (!fs.existsSync(executable)) throw new Error('Missing Chromium executable');
const watchdog = setTimeout(() => {
  console.error('Sandboxed Chromium setup probe exceeded 15 seconds');
  process.exit(1); // Playwright's exit hook kills its detached browser process group.
}, 15000);
(async () => {
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    chromiumSandbox: true,
    timeout: 10000,
  });
  await browser.close();
  clearTimeout(watchdog);
  process.stdout.write(JSON.stringify([executable]));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
"#;

#[derive(Debug, thiserror::Error)]
#[error(
    "Preview worker setup: {0}. Install Node.js (>=20) and npm, then run `clep previews install` (Linux may also require Chromium system libraries; no sudo is run automatically)"
)]
pub struct Error(String);

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self(error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self(error.to_string())
    }
}

#[derive(Clone, Debug)]
pub struct Installation {
    root: PathBuf,
    node: PathBuf,
    browsers: PathBuf,
}

impl Installation {
    /// Canonical generation directory, outside the vault by default.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Start the supervisor without consulting PATH or inheriting application secrets.
    /// Pipe closure, not killing Node on drop, lets the supervisor reap Chromium.
    pub fn command(&self) -> Command {
        let mut command = clean_command(&self.node);
        command
            .arg(self.root.join("supervisor.mjs"))
            .current_dir(&self.root)
            .env("PLAYWRIGHT_BROWSERS_PATH", &self.browsers);
        command
    }
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: String,
    generation: String,
    node: PathBuf,
    browser_registry_hash: String,
    executables: Vec<PathBuf>,
}

fn version() -> String {
    let mut hash = blake3::Hasher::new();
    // Bump the installer format independently of the embedded JavaScript.
    hash.update(b"clepsydra-preview-install-v3\0");
    for (name, bytes) in ASSETS {
        hash.update(name.as_bytes());
        hash.update(&(bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
    }
    hash.finalize().to_hex().to_string()
}

fn storage() -> Result<PathBuf, Error> {
    if !cfg!(any(target_os = "macos", target_os = "linux")) {
        return Err(Error(
            "native screenshots are supported only on macOS and Linux".into(),
        ));
    }
    let data = dirs::data_local_dir()
        .filter(|path| path.is_absolute())
        .ok_or_else(|| Error("cannot locate an absolute local data directory".into()))?;
    Ok(data.join("clepsydra/preview-worker"))
}

fn active_path(base: &Path) -> PathBuf {
    base.join(format!("current-{}.json", version()))
}

/// Pure local lookup for this binary's embedded worker version. Never provisions.
pub fn installed() -> Result<Installation, Error> {
    installed_at(&storage()?)
}

fn installed_at(base: &Path) -> Result<Installation, Error> {
    let bytes = fs::read(active_path(base))
        .map_err(|error| Error(format!("no complete installation for this binary: {error}")))?;
    let manifest: Manifest = serde_json::from_slice(&bytes)?;
    if manifest.version != version()
        || !single_component(&manifest.generation)
        || !manifest.node.is_absolute()
    {
        return Err(Error("invalid active installation manifest".into()));
    }
    let root = base.join(&manifest.generation).canonicalize()?;
    validate(&root, &manifest)?;
    Ok(Installation {
        browsers: root.join("browsers"),
        root,
        node: manifest.node,
    })
}

fn single_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn registry_hash(root: &Path) -> Result<String, Error> {
    Ok(blake3::hash(&fs::read(
        root.join("node_modules/playwright-core/browsers.json"),
    )?)
    .to_hex()
    .to_string())
}

fn validate(root: &Path, manifest: &Manifest) -> Result<(), Error> {
    if !executable(&manifest.node) {
        return Err(Error(format!(
            "recorded Node executable is unavailable: {}",
            manifest.node.display()
        )));
    }
    for (name, bytes) in ASSETS {
        if fs::read(root.join(name))? != bytes {
            return Err(Error(format!(
                "installed {name} does not match this binary"
            )));
        }
    }
    let lock: serde_json::Value = serde_json::from_slice(ASSETS[3].1)?;
    for dependency in ["playwright-core", "ws"] {
        let package_path = format!("node_modules/{dependency}");
        let package: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(&package_path).join("package.json"))?)?;
        let expected = lock["packages"][&package_path]["version"]
            .as_str()
            .ok_or_else(|| Error(format!("embedded lock is missing {dependency}")))?;
        if package["version"].as_str() != Some(expected) {
            return Err(Error(format!(
                "installed {dependency} version does not match the pinned package"
            )));
        }
        if !root.join(&package_path).join("index.js").is_file() {
            return Err(Error(format!("incomplete {dependency} installation")));
        }
    }
    for file in [
        "cli.js",
        "index.js",
        "index.mjs",
        "lib/coreBundle.js",
        "lib/bootstrap.js",
        "lib/utilsBundle.js",
    ] {
        if !root
            .join("node_modules/playwright-core")
            .join(file)
            .is_file()
        {
            return Err(Error(format!("incomplete Playwright installation: {file}")));
        }
    }
    if registry_hash(root)? != manifest.browser_registry_hash || manifest.executables.len() != 1 {
        return Err(Error(
            "installed browser revisions do not match the completed setup".into(),
        ));
    }
    let browsers = root.join("browsers").canonicalize()?;
    for relative in &manifest.executables {
        if !relative.starts_with("browsers")
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(Error("browser executable escapes its managed cache".into()));
        }
        let path = root.join(relative).canonicalize()?;
        if !path.starts_with(&browsers) || !executable(&path) {
            return Err(Error(format!(
                "incomplete Chromium installation: {}",
                relative.display()
            )));
        }
    }
    Ok(())
}

fn clean_command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.env_clear();
    // Deliberately exclude NODE_*, npm config, proxy, loader and Clepsydra settings.
    for key in ["HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command.env("PATH", "/usr/bin:/bin");
    command
}

fn resolve(name: &str, path: Option<&OsStr>) -> Result<PathBuf, Error> {
    if let Some(path) = path {
        for directory in std::env::split_paths(path) {
            // Empty/relative PATH entries must never make setup run a checkout file.
            if !directory.is_absolute() {
                continue;
            }
            let candidate = directory.join(name);
            if executable(&candidate) {
                return Ok(candidate.canonicalize()?);
            }
        }
    }
    Err(Error(format!(
        "required executable `{name}` was not found on an absolute PATH entry"
    )))
}

/// Explicitly download the pinned npm package and matching Chromium. No sudo,
/// application config, current-directory assets, or server connection is needed.
pub async fn install() -> Result<Installation, Error> {
    let base = storage()?;
    let path = std::env::var_os("PATH");
    let node = resolve("node", path.as_deref())?;
    let npm = resolve("npm", path.as_deref())?;
    install_at(&base, &node, &npm).await
}

async fn checked(command: &mut Command, step: &str) -> Result<(), Error> {
    let status = command
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .map_err(|error| Error(format!("{step} could not start: {error}")))?;
    if !status.success() {
        return Err(Error(format!(
            "{step} failed ({status}); previous installation was retained"
        )));
    }
    Ok(())
}

async fn install_at(base: &Path, node: &Path, npm: &Path) -> Result<Installation, Error> {
    fs::create_dir_all(base)?;
    let base = base.canonicalize()?;
    let stage = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&base)?;
    for (name, bytes) in ASSETS {
        fs::write(stage.path().join(name), bytes)?;
    }
    fs::create_dir(stage.path().join("browsers"))?;
    fs::create_dir(stage.path().join("jobs"))?;

    let mut node_check = clean_command(node);
    node_check.arg("-e").arg("if (Number(process.versions.node.split('.')[0]) < 20) { console.error('Node.js >=20 is required'); process.exit(1); }");
    checked(&mut node_check, "Node prerequisite check").await?;

    // npm may be a version-manager wrapper, not JavaScript. Execute its shebang
    // directly, with the selected Node first on an otherwise minimal PATH.
    let node_directory = node
        .parent()
        .ok_or_else(|| Error("Node executable has no parent directory".into()))?;
    let npm_path = std::env::join_paths([node_directory, Path::new("/usr/bin"), Path::new("/bin")])
        .map_err(|error| Error(format!("cannot construct npm executable PATH: {error}")))?;
    let mut npm_command = clean_command(npm);
    npm_command
        .env("PATH", npm_path)
        .args(["ci", "--ignore-scripts", "--no-audit", "--no-fund"])
        .arg("--cache")
        .arg(stage.path().join("npm-cache"))
        .arg("--userconfig")
        .arg(stage.path().join("npm-userconfig"))
        .arg("--globalconfig")
        .arg(stage.path().join("npm-globalconfig"))
        .env("HOME", stage.path())
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
        .current_dir(stage.path());
    checked(&mut npm_command, "pinned Playwright installation").await?;

    let mut browser_command = clean_command(node);
    browser_command
        .arg(stage.path().join("node_modules/playwright-core/cli.js"))
        .args(["install", "chromium", "--no-shell"])
        .env("PLAYWRIGHT_BROWSERS_PATH", stage.path().join("browsers"))
        .env("HOME", stage.path())
        .current_dir(stage.path());
    checked(&mut browser_command, "managed Chromium installation").await?;

    let probe_home = tempfile::Builder::new()
        .prefix(".probe-")
        .tempdir_in(stage.path().join("jobs"))?;
    let output = clean_command(node)
        .args(["-e", PROBE])
        .env("PLAYWRIGHT_BROWSERS_PATH", stage.path().join("browsers"))
        .env("HOME", probe_home.path())
        .env("TMPDIR", probe_home.path())
        .env("XDG_CONFIG_HOME", probe_home.path())
        .env("XDG_CACHE_HOME", probe_home.path())
        .env("XDG_DATA_HOME", probe_home.path())
        .env("XDG_RUNTIME_DIR", probe_home.path())
        .current_dir(stage.path())
        .stdin(Stdio::null())
        .output()
        .await?;
    drop(probe_home);
    if !output.status.success() {
        return Err(Error(format!(
            "Chromium installation validation failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let executables: Vec<PathBuf> = serde_json::from_slice(&output.stdout)?;
    let executables = executables
        .into_iter()
        .map(|path| {
            path.strip_prefix(stage.path())
                .map(Path::to_path_buf)
                .map_err(|_| Error("Playwright selected an unmanaged browser executable".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let generation = format!("{}-{}", version(), uuid::Uuid::now_v7());
    let manifest = Manifest {
        version: version(),
        generation,
        node: node.to_path_buf(),
        browser_registry_hash: registry_hash(stage.path())?,
        executables,
    };
    validate(stage.path(), &manifest)?;
    // The npm cache is not a runtime dependency and can be much larger than npm itself.
    let npm_cache = stage.path().join("npm-cache");
    if npm_cache.exists() {
        fs::remove_dir_all(npm_cache)?;
    }
    let root = base.join(&manifest.generation);
    // Playwright's per-cache GC follows .links contents to live npm packages.
    // Relocate those references before publishing, otherwise they point at the
    // removed staging directory. Link filenames are opaque to the GC reader.
    let links = stage.path().join("browsers/.links");
    if links.is_dir() {
        for link in fs::read_dir(links)? {
            let path = link?.path();
            let package = fs::read_to_string(&path)?;
            let relative = Path::new(&package)
                .strip_prefix(stage.path())
                .map_err(|_| Error("browser cache references an unmanaged package".into()))?;
            fs::write(path, root.join(relative).to_string_lossy().as_bytes())?;
        }
    }
    fs::rename(stage.path(), &root)?;
    let activation = (|| -> Result<(), Error> {
        let mut current = tempfile::NamedTempFile::new_in(&base)?;
        current.write_all(&serde_json::to_vec(&manifest)?)?;
        current.as_file().sync_all()?;
        current
            .persist(active_path(&base))
            .map_err(|error| Error(error.to_string()))?;
        Ok(())
    })();
    if let Err(error) = activation {
        let _ = fs::remove_dir_all(&root);
        return Err(error);
    }
    Ok(Installation {
        browsers: root.join("browsers"),
        root,
        node: node.to_path_buf(),
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    struct Fixture {
        temp: tempfile::TempDir,
        base: PathBuf,
        node: PathBuf,
        npm: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let tools = temp.path().join("fixture-tools");
            fs::create_dir(&tools).unwrap();
            let node = tools.join("node");
            let npm = tools.join("npm.js");
            fs::write(&npm, "#!/bin/sh\nexec node --fixture-npm \"$@\"\n").unwrap();
            fs::set_permissions(&npm, fs::Permissions::from_mode(0o700)).unwrap();
            let lock: serde_json::Value = serde_json::from_slice(ASSETS[3].1).unwrap();
            fs::write(
                tools.join("package.json"),
                serde_json::to_vec(&serde_json::json!({
                    "version": lock["packages"]["node_modules/playwright-core"]["version"]
                }))
                .unwrap(),
            )
            .unwrap();
            fs::write(
                tools.join("ws-package.json"),
                serde_json::to_vec(&serde_json::json!({
                    "version": lock["packages"]["node_modules/ws"]["version"]
                }))
                .unwrap(),
            )
            .unwrap();
            // All downloads/process steps are replaced at the executable seam.
            // Paths with spaces exercise argv/cwd handling without a shell in production.
            fs::write(&node, r#"#!/bin/sh
set -eu
tools=${0%/*}
printf 'called\n' >> "$tools/calls"
case "$1" in
  -e)
    case "$2" in
      *executablePath*)
        case "$HOME" in "$PWD"/jobs/.probe-*) ;; *) exit 5 ;; esac
        [ "$TMPDIR" = "$HOME" ]
        [ "$XDG_CONFIG_HOME" = "$HOME" ]
        if [ -e "$tools/sandbox-unavailable" ]; then printf 'sandbox unavailable\n' >&2; exit 6; fi
        if [ -e "$tools/bad-probe" ]; then printf 'not json'; exit 0; fi
        printf '["%s/browsers/chromium/chrome"]' "$PWD"
        ;;
      *)
        if [ -e "$tools/old-node" ]; then exit 1; fi
        ;;
    esac
    ;;
  --fixture-npm)
    [ "$2" = ci ]
    [ "$3" = --ignore-scripts ]
    [ -z "${NODE_OPTIONS-}" ]
    [ -z "${CLEPSYDRA__SECRET-}" ]
    [ -z "${HTTPS_PROXY-}" ]
    if [ -e "$tools/fail-npm" ]; then exit 2; fi
    mkdir -p node_modules/playwright-core/lib node_modules/ws
    cp "$tools/package.json" node_modules/playwright-core/package.json
    cp "$tools/ws-package.json" node_modules/ws/package.json
    touch node_modules/ws/index.js
    if [ -e "$tools/incomplete-ws" ]; then rm node_modules/ws/index.js; fi
    printf '{"revision":"fixture-pinned"}' > node_modules/playwright-core/browsers.json
    touch node_modules/playwright-core/cli.js node_modules/playwright-core/index.js node_modules/playwright-core/index.mjs node_modules/playwright-core/lib/coreBundle.js node_modules/playwright-core/lib/bootstrap.js node_modules/playwright-core/lib/utilsBundle.js
    if [ -e "$tools/wrong-version" ]; then printf '{"version":"0.0.0"}' > node_modules/playwright-core/package.json; fi
    ;;
  */cli.js)
    [ "$2" = install ]
    [ "$3" = chromium ]
    [ "$4" = --no-shell ]
    [ "$PLAYWRIGHT_BROWSERS_PATH" = "$PWD/browsers" ]
    if [ -e "$tools/fail-browser" ]; then exit 3; fi
    mkdir -p browsers/chromium browsers/.links
    touch browsers/chromium/chrome
    chmod 700 browsers/chromium/chrome
    printf '%s/node_modules/playwright-core' "$PWD" > browsers/.links/fixture
    if [ -e "$tools/incomplete" ]; then rm browsers/chromium/chrome; fi
    ;;
  */supervisor.mjs)
    printf '%s\n%s\n' "$PWD" "$PLAYWRIGHT_BROWSERS_PATH"
    /usr/bin/env
    ;;
  *) exit 4 ;;
esac
"#).unwrap();
            fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
            Self {
                base: temp.path().join("local data"),
                temp,
                node,
                npm,
            }
        }

        async fn install(&self) -> Result<Installation, Error> {
            install_at(&self.base, &self.node, &self.npm).await
        }

        fn flag(&self, name: &str) -> PathBuf {
            self.temp.path().join("fixture-tools").join(name)
        }
    }

    #[tokio::test]
    async fn installs_through_npm_wrapper_and_lookup_never_spawns() {
        let fixture = Fixture::new();
        assert!(installed_at(&fixture.base).is_err());
        let installation = fixture.install().await.unwrap();
        assert!(installation.root().is_absolute());
        let calls = fs::read(fixture.flag("calls")).unwrap();
        let found = installed_at(&fixture.base).unwrap();
        assert_eq!(found.root(), installation.root());
        assert_eq!(fs::read(fixture.flag("calls")).unwrap(), calls);
        assert!(found.root().join("jobs").is_dir());
        assert_eq!(fs::read_dir(found.root().join("jobs")).unwrap().count(), 0);
        let linked_package =
            fs::read_to_string(found.root().join("browsers/.links/fixture")).unwrap();
        assert_eq!(
            Path::new(&linked_package),
            found.root().join("node_modules/playwright-core")
        );
        assert!(Path::new(&linked_package).is_dir());
        let second = fixture.install().await.unwrap();
        assert_ne!(second.root(), found.root());
        assert_eq!(installed_at(&fixture.base).unwrap().root(), second.root());
        assert!(
            found.root().is_dir(),
            "in-flight captures retain their generation"
        );
    }

    #[tokio::test]
    async fn every_failed_setup_retains_previous_activation() {
        let fixture = Fixture::new();
        let prior = fixture.install().await.unwrap();
        let active = fs::read(active_path(&fixture.base)).unwrap();
        for failure in [
            "old-node",
            "fail-npm",
            "fail-browser",
            "incomplete",
            "incomplete-ws",
            "wrong-version",
            "bad-probe",
            "sandbox-unavailable",
        ] {
            fs::write(fixture.flag(failure), "").unwrap();
            let error = fixture.install().await.unwrap_err();
            assert!(
                error.to_string().contains("clep previews install"),
                "{error}"
            );
            assert_eq!(fs::read(active_path(&fixture.base)).unwrap(), active);
            assert_eq!(installed_at(&fixture.base).unwrap().root(), prior.root());
            fs::remove_file(fixture.flag(failure)).unwrap();
            assert!(!fs::read_dir(&fixture.base).unwrap().any(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".staging-")
            }));
        }
    }

    #[tokio::test]
    async fn failed_first_install_never_becomes_discoverable() {
        let fixture = Fixture::new();
        fs::write(fixture.flag("incomplete"), "").unwrap();
        assert!(fixture.install().await.is_err());
        assert!(installed_at(&fixture.base).is_err());
        assert!(!active_path(&fixture.base).exists());
        assert_eq!(fs::read_dir(&fixture.base).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn rejects_incomplete_assets_browser_revisions_and_removed_node() {
        let fixture = Fixture::new();
        let installation = fixture.install().await.unwrap();
        let root = installation.root();
        let worker = root.join("worker.mjs");
        let bytes = fs::read(&worker).unwrap();
        fs::write(&worker, "obsolete").unwrap();
        assert!(installed_at(&fixture.base).is_err());
        fs::write(&worker, bytes).unwrap();
        let registry = root.join("node_modules/playwright-core/browsers.json");
        let bytes = fs::read(&registry).unwrap();
        fs::write(&registry, "{\"revision\":\"different\"}").unwrap();
        assert!(installed_at(&fixture.base).is_err());
        fs::write(&registry, bytes).unwrap();
        fs::remove_file(root.join("browsers/chromium/chrome")).unwrap();
        assert!(installed_at(&fixture.base).is_err());
        let installation = fixture.install().await.unwrap();
        assert_eq!(
            installed_at(&fixture.base).unwrap().root(),
            installation.root()
        );
        fs::remove_file(&fixture.node).unwrap();
        assert!(installed_at(&fixture.base).is_err());
    }

    #[tokio::test]
    async fn ignores_obsolete_manifests_and_rejects_traversal() {
        let fixture = Fixture::new();
        fixture.install().await.unwrap();
        let active = active_path(&fixture.base);
        let mut manifest: Manifest = serde_json::from_slice(&fs::read(&active).unwrap()).unwrap();
        manifest.version = "old-binary".into();
        fs::write(&active, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(installed_at(&fixture.base).is_err());
        manifest.version = version();
        manifest.generation = "../escape".into();
        fs::write(&active, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(installed_at(&fixture.base).is_err());
    }

    #[tokio::test]
    async fn launches_recorded_node_in_generation_with_managed_browser_cache() {
        let fixture = Fixture::new();
        let installation = fixture.install().await.unwrap();
        let mut command = installation.command();
        let env = command
            .as_std()
            .get_envs()
            .map(|(key, _)| key.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(env.iter().all(|key| {
            [
                "HOME",
                "TMPDIR",
                "LANG",
                "LC_ALL",
                "LC_CTYPE",
                "TZ",
                "PATH",
                "PLAYWRIGHT_BROWSERS_PATH",
            ]
            .contains(&key.as_str())
        }));
        assert_eq!(command.as_std().get_program(), fixture.node);
        let output = command.output().await.unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let mut lines = stdout.lines();
        assert_eq!(lines.next().unwrap(), installation.root().to_str().unwrap());
        assert_eq!(
            lines.next().unwrap(),
            installation.browsers.to_str().unwrap()
        );
    }

    #[test]
    fn prerequisites_reject_relative_path_and_missing_tools() {
        assert!(
            resolve("node", None)
                .unwrap_err()
                .to_string()
                .contains("Node.js")
        );
        assert!(resolve("node", Some(OsStr::new(".:relative:"))).is_err());
        let fixture = Fixture::new();
        assert_eq!(
            resolve("node", Some(fixture.node.parent().unwrap().as_os_str())).unwrap(),
            fixture.node.canonicalize().unwrap()
        );
        assert!(resolve("npm", Some(fixture.node.parent().unwrap().as_os_str())).is_err());
    }
}
