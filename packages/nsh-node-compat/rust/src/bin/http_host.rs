use rquickjs::{Ctx, Function, prelude::Async};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
struct Response {
    response: reqwest::Response,
    bytes: usize,
}
struct Request {
    cancel: tokio::sync::watch::Sender<bool>,
    response: Arc<tokio::sync::Mutex<Option<Response>>>,
}
fn result(result: Result<Value, String>) -> String {
    match result {
        Ok(value) => json!({"value":value}).to_string(),
        Err(error) => json!({"error":error}).to_string(),
    }
}
/// Test runner only. A configured gateway origin is the sole allowed network
/// destination; credentials are not inherited from the parent environment.
pub fn install(ctx: &Ctx<'_>, base_url: &str) -> rquickjs::Result<()> {
    let origin = reqwest::Url::parse(base_url)
        .map_err(|e| rquickjs::Error::new_from_js_message("url", "origin", e.to_string()))?
        .origin()
        .ascii_serialization();
    let requests: Arc<Mutex<HashMap<String, Request>>> = Arc::new(Mutex::new(HashMap::new()));
    let register = requests.clone();
    ctx.globals().set(
        "__nsh_http_create",
        Function::new(ctx.clone(), move || -> String {
            let mut requests = register.lock().unwrap();
            if requests.len() >= 16 {
                return String::new();
            }
            let id = uuid::Uuid::new_v4().to_string();
            let (cancel, _) = tokio::sync::watch::channel(false);
            requests.insert(
                id.clone(),
                Request {
                    cancel,
                    response: Arc::new(tokio::sync::Mutex::new(None)),
                },
            );
            id
        })?,
    )?;
    let cancel = requests.clone();
    ctx.globals().set(
        "__nsh_http_cancel",
        Function::new(ctx.clone(), move |id: String| {
            if let Some(request) = cancel.lock().unwrap().remove(&id) {
                let _ = request.cancel.send(true);
            }
        })?,
    )?;
    let open = requests.clone();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| rquickjs::Error::new_from_js_message("http", "client", e.to_string()))?;
    ctx.globals().set("__nsh_http_open",Function::new(ctx.clone(),Async(move|raw:String| {let requests=open.clone();let client=client.clone();let origin=origin.clone();async move {
        let setup=(||->Result<_,String>{let v:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;let id=v["id"].as_str().ok_or("missing id")?;let req=requests.lock().unwrap();let req=req.get(id).ok_or("ABORT_ERR")?;Ok((v.clone(),req.cancel.subscribe(),req.response.clone()))})();
        let outcome=async {let(v,mut cancel,response)=setup?;let url=reqwest::Url::parse(v["url"].as_str().ok_or("missing url")?).map_err(|e|e.to_string())?;if url.origin().ascii_serialization()!=origin || !["https","http"].contains(&url.scheme()){return Err("EACCES: unconfigured HTTP origin".into());}let method=reqwest::Method::from_bytes(v["method"].as_str().unwrap_or("GET").as_bytes()).map_err(|e|e.to_string())?;let mut request=client.request(method,url);if let Some(headers)=v["headers"].as_object(){for(k,v)in headers{if let Some(v)=v.as_str(){request=request.header(k,v);}}}if let Some(body)=v["body"].as_str(){if body.len()>1024*1024{return Err("HTTP request body limit".into());}request=request.body(body.to_owned());}let received=tokio::select!{_ = cancel.changed()=>return Err("ABORT_ERR".into()), r=request.send()=>r.map_err(|e|e.to_string())?};let headers=received.headers().iter().filter_map(|(k,v)|v.to_str().ok().map(|v|(k.as_str().to_owned(),v.to_owned()))).collect::<HashMap<_,_>>();let status=received.status().as_u16();*response.lock().await=Some(Response{response:received,bytes:0});Ok(json!({"status":status,"headers":headers}))}.await;result(outcome)
    }}))?)?;
    let read = requests.clone();
    ctx.globals().set("__nsh_http_read",Function::new(ctx.clone(),Async(move|id:String| {let requests=read.clone();async move {
        let setup={let req=requests.lock().unwrap();req.get(&id).map(|r|(r.cancel.subscribe(),r.response.clone())).ok_or("ABORT_ERR".to_owned())};
        let outcome=async{let(mut cancel,response)=setup?;let mut guard=response.lock().await;let response=guard.as_mut().ok_or("closed HTTP response")?;let chunk=tokio::select!{_=cancel.changed()=>return Err("ABORT_ERR".into()),r=response.response.chunk()=>r.map_err(|e|e.to_string())?};if let Some(bytes)=chunk{response.bytes+=bytes.len();if response.bytes>16*1024*1024{return Err("HTTP response body limit".into());}Ok(json!(bytes.to_vec()))}else{requests.lock().unwrap().remove(&id);Ok(Value::Null)}}.await;result(outcome)
    }}))?)?;
    Ok(())
}
