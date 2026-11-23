use std::{env, path::PathBuf};

use cc_switch_lib::{sync_all_unlocked, tps_session_providers as sources, Database};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let home = PathBuf::from(env::var_os("ORCA_TPS_SCAN_HOME").ok_or("missing scan directory")?);
    if !home.is_absolute() {
        return Err("scan directory must be absolute".into());
    }

    // Upstream resolves the source sessions against the real user home during the scan.
    let previous = env::var_os("CC_SWITCH_TEST_HOME");
    env::set_var("CC_SWITCH_TEST_HOME", &home);
    let db = Database::init();
    match previous {
        Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
        None => env::remove_var("CC_SWITCH_TEST_HOME"),
    }
    let result = sync_all_unlocked(&db?);
    let mut projects = Vec::new();
    if result.imported > 0 || env::var_os("ORCA_TPS_SCAN_PROJECTS").is_some() {
        for scanner in [
            sources::gemini::scan_sessions,
            sources::grokbuild::scan_sessions,
            sources::omp::scan_sessions,
            sources::mcode::scan_sessions,
            sources::kimi::scan_sessions,
            sources::copilot::scan_sessions,
            sources::workbuddy::scan_sessions,
            sources::dsh::scan_sessions,
        ] {
            for session in scanner() {
                if let Some(directory) = session.project_dir {
                    projects.push((session.provider_id, session.session_id, directory));
                }
            }
        }
    }
    println!("{}", serde_json::json!({ "projects": projects }));
    Ok(())
}
