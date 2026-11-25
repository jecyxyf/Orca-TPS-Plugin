use std::{env, io, path::PathBuf, sync::Arc};

use cc_switch_lib::{sync_session_usage, AppState, Database};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::Manager;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Range {
    name: String,
    start_date: i64,
    end_date: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    windows: Vec<Range>,
    days: Vec<Range>,
    app_type: Option<String>,
    model_limit: usize,
}

fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let request: Request = serde_json::from_reader(io::stdin().lock())?;
    let home = PathBuf::from(env::var_os("ORCA_TPS_CC_SWITCH_HOME").ok_or("missing database home")?);
    if !home.is_absolute() {
        return Err("database home must be absolute".into());
    }

    // Keep the database private to the plugin while the original scanner resolves its normal log roots.
    let source_home = env::var_os("CC_SWITCH_TEST_HOME");
    env::set_var("CC_SWITCH_TEST_HOME", &home);
    let database = Database::init();
    match source_home {
        Some(value) => env::set_var("CC_SWITCH_TEST_HOME", value),
        None => env::remove_var("CC_SWITCH_TEST_HOME"),
    }
    let db = Arc::new(database?);
    let app = tauri::test::mock_app();
    app.manage(AppState::new(Arc::clone(&db)));
    let sync = tauri::async_runtime::block_on(sync_session_usage(app.state()))?;
    if !sync.errors.is_empty() {
        return Err(sync.errors.join("; ").into());
    }

    let app_type = request.app_type.as_deref();
    let mut windows = serde_json::Map::new();
    for range in request.windows {
        let from = Some(range.start_date);
        let to = Some(range.end_date);
        let summary = db.get_usage_summary(from, to, app_type, None, None)?;
        let mut models = Vec::new();
        for entry in db.get_usage_summary_by_app(from, to, None, None)? {
            if app_type.is_some_and(|app| app != entry.app_type) {
                continue;
            }
            for model in db.get_model_stats(from, to, Some(&entry.app_type), None, None)? {
                models.push((entry.app_type.clone(), model));
            }
        }
        models.sort_by(|a, b| b.1.total_tokens.cmp(&a.1.total_tokens).then(b.1.request_count.cmp(&a.1.request_count)));
        let hidden_rows = models.len().saturating_sub(request.model_limit);
        let mut rows = Vec::new();
        for (app_type, model) in models.into_iter().take(request.model_limit) {
            let usage = db.get_usage_summary(from, to, Some(&app_type), None, Some(&model.model))?;
            rows.push(json!({ "appType": app_type, "model": model.model, "usage": usage }));
        }
        windows.insert(range.name, json!({ "summary": summary, "rows": rows, "hiddenRows": hidden_rows }));
    }

    let mut daily = Vec::new();
    for day in request.days {
        let usage = db.get_usage_summary(Some(day.start_date), Some(day.end_date), app_type, None, None)?;
        if usage.total_requests != 0 || usage.real_total_tokens != 0 {
            daily.push(json!({ "day": day.name, "tokens": usage.real_total_tokens, "requests": usage.total_requests }));
        }
    }
    Ok(json!({ "revision": "a3eafa408ae679db2e3401fca767ed2b89d9a2b2", "windows": windows, "daily": daily }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("{}", run()?);
    Ok(())
}
