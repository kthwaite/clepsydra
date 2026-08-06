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
