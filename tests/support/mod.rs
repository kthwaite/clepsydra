#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use axum::Router;
use axum_test::TestServer;
use clepsydra::api::{AppState, Clock, SystemClock, api_router};
use clepsydra::vault::Vault;
use clepsydra::vault::academic_hook::AcademicMoveHook;
use clepsydra::vault::cas::ContentStore;
use clepsydra::vault::hooks::{PostDeleteHook, PostMoveHook};
use clepsydra::vault::index::VaultIndex;
use clepsydra::vault::index_handle::IndexHandle;
use clepsydra::vault::init::init_vault;
use tempfile::TempDir;
use tokio::sync::broadcast;

type RootAction = Box<dyn FnOnce(&Path)>;
type StateAction = Box<dyn FnOnce(&Arc<AppState>)>;
type DeleteHookFactory =
    Box<dyn FnOnce(&Arc<parking_lot::Mutex<ContentStore>>) -> Vec<Box<dyn PostDeleteHook>>>;

pub struct ApiFixture {
    pub app: Router,
    pub server: TestServer,
    pub temp_dir: TempDir,
    pub state: Arc<AppState>,
}

impl ApiFixture {
    pub fn builder() -> ApiFixtureBuilder {
        ApiFixtureBuilder::default()
    }

    pub fn into_server_and_temp(self) -> (TestServer, TempDir) {
        (self.server, self.temp_dir)
    }

    pub fn into_parts(self) -> (TestServer, TempDir, Arc<AppState>) {
        (self.server, self.temp_dir, self.state)
    }
}

pub struct ApiFixtureBuilder {
    configure: Option<RootAction>,
    pre_index_seed: Option<RootAction>,
    post_index_mutation: Option<StateAction>,
    clock: Arc<dyn Clock>,
    hooks: Arc<Vec<Box<dyn PostMoveHook>>>,
    delete_hook_factory: Option<DeleteHookFactory>,
}

impl Default for ApiFixtureBuilder {
    fn default() -> Self {
        Self {
            configure: None,
            pre_index_seed: None,
            post_index_mutation: None,
            clock: Arc::new(SystemClock),
            hooks: Arc::new(vec![Box::new(AcademicMoveHook)]),
            delete_hook_factory: None,
        }
    }
}

impl ApiFixtureBuilder {
    /// Runs after vault initialization and before pre-index seeding.
    pub fn configure(mut self, configure: impl FnOnce(&Path) + 'static) -> Self {
        self.configure = Some(Box::new(configure));
        self
    }

    /// Seeds files before `VaultIndex::build`; seeded files are visible at startup.
    pub fn pre_index_seed(mut self, seed: impl FnOnce(&Path) + 'static) -> Self {
        self.pre_index_seed = Some(Box::new(seed));
        self
    }

    /// Mutates the fully constructed state after indexing and before routing.
    /// This is intentionally distinct from `pre_index_seed`: filesystem writes
    /// here are not silently indexed.
    pub fn post_index_mutation(mut self, mutate: impl FnOnce(&Arc<AppState>) + 'static) -> Self {
        self.post_index_mutation = Some(Box::new(mutate));
        self
    }

    pub fn clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn hooks(mut self, hooks: Arc<Vec<Box<dyn PostMoveHook>>>) -> Self {
        self.hooks = hooks;
        self
    }

    pub fn delete_hooks_with(
        mut self,
        factory: impl FnOnce(&Arc<parking_lot::Mutex<ContentStore>>) -> Vec<Box<dyn PostDeleteHook>>
        + 'static,
    ) -> Self {
        self.delete_hook_factory = Some(Box::new(factory));
        self
    }

    pub fn build(self) -> ApiFixture {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("vault");
        init_vault(&root).unwrap();

        if let Some(configure) = self.configure {
            configure(&root);
        }
        if let Some(seed) = self.pre_index_seed {
            seed(&root);
        }

        let vault = Vault::open(&root).unwrap();
        let archive_resource_concurrency = clepsydra::api::archive::archive_resource_concurrency(
            vault.config().archive.max_blob_size_mb,
        );
        let db_path = vault.root().join(".clepsydra/cache.db");
        let mut index = VaultIndex::open(&db_path).unwrap();
        index.build(&vault).unwrap();
        index.resolve_links().unwrap();

        let cas_path = tmp.path().join("cas");
        let cas = Arc::new(parking_lot::Mutex::new(
            ContentStore::open(&cas_path).unwrap(),
        ));
        let rubbish = clepsydra::vault::rubbish::RubbishStore::for_vault(vault.root());
        let delete_hooks = self
            .delete_hook_factory
            .map_or_else(Vec::new, |factory| factory(&cas));
        let index = IndexHandle::spawn(index, vault.clone());
        let (change_tx, _) = broadcast::channel(64);
        let state = Arc::new(AppState {
            started_at: std::time::Instant::now(),
            features: clepsydra::FeatureFlags::default(),
            clock: self.clock,
            vault,
            index,
            cas,
            rubbish,
            warnings: parking_lot::Mutex::new(Vec::new()),
            change_tx,
            hooks: self.hooks,
            delete_hooks: Arc::new(delete_hooks),
            mutation_coordinator: clepsydra::vault::mutation_coordinator::MutationCoordinator::new(
            ),
            sync: None,
            watcher_paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            feed_runtime: Some(
                clepsydra::feeds::runtime::FeedRuntime::open(
                    &root,
                    &clepsydra::FeedsSettings::default(),
                )
                .unwrap(),
            ),
            archive_ingest_lock: tokio::sync::Mutex::new(()),
            archive_view_semaphore: Arc::new(tokio::sync::Semaphore::new(1)),
            archive_resource_semaphore: Arc::new(tokio::sync::Semaphore::new(
                archive_resource_concurrency,
            )),
            bcl: None,
            location: parking_lot::RwLock::new(None),
        });

        if let Some(mutate) = self.post_index_mutation {
            mutate(&state);
        }

        let app: Router = Router::new()
            .nest("/api/vault", api_router())
            .merge(clepsydra::api::deeplink::root_router())
            .with_state(Arc::clone(&state));
        let server = TestServer::new(app.clone()).unwrap();
        ApiFixture {
            server,
            app,
            temp_dir: tmp,
            state,
        }
    }
}

/// Declare a project: create a PROJECT page at `projects/<slug>/<slug>.md`
/// whose `project` is `slug`. Every non-PROJECT page that names `slug` needs
/// this first — the server refuses a `project` no PROJECT page declares.
pub async fn seed_project(server: &TestServer, slug: &str) {
    server
        .post(&format!("/api/vault/pages/projects/{slug}/{slug}.md"))
        .json(&serde_json::json!({
            "title": slug,
            "kind": "PROJECT",
            "project": slug,
        }))
        .await
        .assert_status(axum::http::StatusCode::CREATED);
}
