use serde_json::{Value, json};
pub fn segment(v: &Value) -> Result<Value, String> {
    let text = v["input"].as_str().ok_or("missing segmentation input")?;
    if text.len() > 1024 * 1024 {
        return Err("ENOBUFS: segmentation input limit".into());
    }
    let utf16 = text.encode_utf16().collect::<Vec<_>>();
    let mut out = vec![];
    let mut start = 0;
    match v["granularity"].as_str().unwrap_or("grapheme") {
        "word" => {
            let segmenter = icu_segmenter::WordSegmenter::new_auto(Default::default());
            for (end, kind) in segmenter.segment_utf16(&utf16).iter_with_word_type() {
                if end > start {
                    push(
                        &mut out,
                        json!({"start":start,"end":end,"isWordLike":kind.is_word_like()}),
                    )?;
                }
                start = end;
            }
        }
        "grapheme" => {
            for end in icu_segmenter::GraphemeClusterSegmenter::new().segment_utf16(&utf16) {
                if end > start {
                    push(&mut out, json!({"start":start,"end":end}))?;
                }
                start = end;
            }
        }
        "sentence" => {
            for end in
                icu_segmenter::SentenceSegmenter::new(Default::default()).segment_utf16(&utf16)
            {
                if end > start {
                    push(&mut out, json!({"start":start,"end":end}))?;
                }
                start = end;
            }
        }
        _ => return Err("invalid segmentation granularity".into()),
    }
    if out.len() > 100000 {
        return Err("ENOBUFS: segmentation output limit".into());
    }
    Ok(json!(out))
}

fn push(out: &mut Vec<Value>, value: Value) -> Result<(), String> {
    if out.len() >= 100000 {
        return Err("ENOBUFS: segmentation output limit".into());
    }
    out.push(value);
    Ok(())
}
