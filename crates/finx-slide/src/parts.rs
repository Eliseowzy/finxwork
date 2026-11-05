//! Byte comparison of two OPC packages, part by part.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use zip::ZipArchive;
use zip::result::ZipResult;

/// Parts whose bytes differ between `before` and `after`, or that only one of them has.
pub(crate) fn changed(before: &[u8], after: &[u8]) -> ZipResult<Vec<String>> {
    let (before, mut after) = (parts(before)?, parts(after)?);
    let mut changed: Vec<String> = before
        .into_iter()
        .filter(|(name, bytes)| after.remove(name).as_ref() != Some(bytes))
        .map(|(name, _)| name)
        .collect();
    changed.extend(after.into_keys());
    changed.sort();
    Ok(changed)
}

fn parts(package: &[u8]) -> ZipResult<BTreeMap<String, Vec<u8>>> {
    let mut archive = ZipArchive::new(Cursor::new(package))?;
    let mut parts = BTreeMap::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes)?;
        parts.insert(entry.name()?.into_owned(), bytes);
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;

    fn package(parts: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, body) in parts {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(body.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }

    #[test]
    fn only_differing_parts_are_changed() {
        let before = package(&[("a.xml", "1"), ("b.xml", "2"), ("gone.xml", "3")]);
        let after = package(&[("b.xml", "2"), ("a.xml", "9"), ("new.xml", "4")]);
        assert_eq!(
            changed(&before, &after).unwrap(),
            ["a.xml", "gone.xml", "new.xml"]
        );
        assert!(changed(&before, &before).unwrap().is_empty());
    }
}
