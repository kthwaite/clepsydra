use std::fs;

use rusqlite::params;

use crate::vault::Vault;
use crate::vault::hooks::PostMoveHook;
use crate::vault::index::VaultIndex;
use crate::vault::page::{parse_frontmatter, write_page_content};
use crate::vault::path::VaultPath;

/// Rewrites `work_path` in annotation frontmatter when the referenced work page is moved.
pub struct AcademicMoveHook;

impl PostMoveHook for AcademicMoveHook {
    fn on_page_moved(
        &self,
        _old_path: &VaultPath,
        new_path: &VaultPath,
        page_id: &uuid::Uuid,
        vault: &Vault,
        index: &VaultIndex,
    ) -> Result<(), Box<dyn std::error::Error>> {
        // Find annotation pages whose work_id matches the moved page's UUID
        let page_id_str = page_id.to_string();
        let mut stmt = index.connection().prepare(
            "SELECT path FROM pages WHERE json_extract(meta_json, '$.kind') = 'annotation' AND json_extract(meta_json, '$.work_id') = ?1"
        )?;

        let annotation_paths: Vec<String> = stmt
            .query_map(params![page_id_str], |row| row.get::<_, String>(0))?
            .filter_map(|r| r.ok())
            .collect();

        for ann_path_str in annotation_paths {
            let ann_vp = VaultPath::new(&ann_path_str)?;
            let ann_abs = vault.resolve(&ann_vp);

            let content = fs::read_to_string(&ann_abs)?;
            let (mut meta, body) = parse_frontmatter(&content)?;

            // Update work_path in extra
            meta.extra.insert(
                "work_path".to_string(),
                toml::Value::String(new_path.as_str().to_string()),
            );

            let new_content = write_page_content(&meta, &body);
            fs::write(&ann_abs, new_content)?;
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annotation_rewrite_failure_is_returned_after_preserving_failed_page() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("vault");
        crate::vault::init::init_vault(&root).unwrap();
        let annotations = root.join("library/annotations");
        fs::create_dir_all(&annotations).unwrap();
        let page_id = uuid::Uuid::parse_str("019fd000-0000-7000-8000-000000000601").unwrap();
        let annotation = annotations.join("highlight.md");
        fs::write(
            &annotation,
            format!(
                "+++\nid = \"019fd000-0000-7000-8000-000000000602\"\nkind = \"annotation\"\nwork_id = \"{page_id}\"\n+++\nbody\n"
            ),
        )
        .unwrap();
        let vault = Vault::open(&root).unwrap();
        let mut index = VaultIndex::open(&root.join(".clepsydra/cache.db")).unwrap();
        index.build(&vault).unwrap();
        let malformed = "+++\nwork_id = [\n+++\nbody\n";
        fs::write(&annotation, malformed).unwrap();

        let error = AcademicMoveHook
            .on_page_moved(
                &VaultPath::new("library/papers/old.md").unwrap(),
                &VaultPath::new("library/papers/new.md").unwrap(),
                &page_id,
                &vault,
                &index,
            )
            .unwrap_err();

        assert!(error.to_string().contains("TOML"));
        assert_eq!(fs::read_to_string(annotation).unwrap(), malformed);
    }
}
