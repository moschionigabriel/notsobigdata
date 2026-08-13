// 21-tests-manifest.js — manifest test category (see PROJECT.md; runAllTests('manifest')).


// ===================================================================
// Tests — the run manifest
// ===================================================================

// The default case: no notsobigdataManifest declared at all, so this
// exercises the real auto-detected-folder codepath (ScriptApp.getScriptId()
// + DriveApp .getParents()) rather than an explicit folderId override -
// that auto-detection was reasoned through but never run, so this is the
// one case most worth checking by hand. Also confirms the CLAUDE.md
// Drive-pileup lesson doesn't repeat here: a second run must overwrite the
// same file, not create a new one.
function testManifestDefaultOverwritesSameFile() {
  var first = NotSoBigData.cli('run --select extractSheets');
  check('first run wrote the manifest', first.manifest.written === true, JSON.stringify(first.manifest));
  var second = NotSoBigData.cli('run --select extractSheets');
  check('second run overwrote the same file', second.manifest.written === true && second.manifest.fileId === first.manifest.fileId,
    first.manifest.fileId + ' vs ' + second.manifest.fileId);
  var content = JSON.parse(DriveApp.getFileById(first.manifest.fileId).getBlob().getDataAsString());
  check('the manifest file itself is well-formed', content.notsobigdata === 'manifest' && content.command === 'run --select extractSheets',
    JSON.stringify(content));
  DriveApp.getFileById(first.manifest.fileId).setTrashed(true);
}


// An explicit folderId/fileName override, same reuse-check shape as
// testLoadDriveUpsertByName above.
function testManifestFolderAndFileNameOverride() {
  withTemporaryNodes({
    notsobigdataManifest: {
      folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID,
      fileName: 'notsobigdata-manifest-override-test.json'
    }
  }, function () {
    var report = NotSoBigData.cli('run --select extractSheets');
    check('manifest wrote to the configured folder/file', report.manifest.written === true, JSON.stringify(report.manifest));
    var file = DriveApp.getFileById(report.manifest.fileId);
    check('the file landed in the configured folder',
      file.getParents().next().getId() === P.NOTSOBIGDATA_DRIVE_FOLDER_ID);
    check('the file got the configured name', file.getName() === 'notsobigdata-manifest-override-test.json', file.getName());
    file.setTrashed(true);
  });
}


// enabled: false must skip the write entirely and report why, without
// touching report.ok or throwing.
function testManifestDisabled() {
  withTemporaryNodes({ notsobigdataManifest: { enabled: false } }, function () {
    var report = NotSoBigData.cli('run --select extractSheets');
    check('manifest reports disabled', report.manifest.written === false && report.manifest.reason === 'disabled', JSON.stringify(report.manifest));
  });
}


// A run mixing success/failed/skipped must be reflected in the manifest
// content, never with the raw rows, and report.ok must stay driven by the
// node results alone - unaffected by the manifest write itself.
function testManifestReflectsMixedNodeStatuses() {
  withTemporaryNodes({
    notsobigdataManifest: { folderId: P.NOTSOBIGDATA_DRIVE_FOLDER_ID, fileName: 'notsobigdata-manifest-mixed-test.json' },
    tmpManifestBoom: {
      kind: 'move', name: 'tmpManifestBoom',
      source: { type: 'drive', fileId: 'this-is-not-a-real-drive-file-id', fileType: 'csv' }
    },
    tmpManifestChild: { kind: 'move', name: 'tmpManifestChild', dependsOn: ['tmpManifestBoom'], source: { type: 'custom', fn: myCustomExtract } },
    tmpManifestOk: { kind: 'move', name: 'tmpManifestOk', source: { type: 'custom', fn: myCustomExtract } }
  }, function () {
    var report = NotSoBigData.cli('run --select tmpManifestBoom,tmpManifestChild,tmpManifestOk');
    check('report is not ok', report.ok === false);
    check('manifest still wrote despite the node failure', report.manifest.written === true, JSON.stringify(report.manifest));
    var content = JSON.parse(DriveApp.getFileById(report.manifest.fileId).getBlob().getDataAsString());
    var byName = {};
    content.nodes.forEach(function (node) { byName[node.name] = node; });
    check('manifest recorded the failure', byName.tmpManifestBoom.status === 'failed' && !!byName.tmpManifestBoom.error, JSON.stringify(byName.tmpManifestBoom));
    check('manifest recorded the skip', byName.tmpManifestChild.status === 'skipped', JSON.stringify(byName.tmpManifestChild));
    check('manifest recorded the success without raw rows', byName.tmpManifestOk.status === 'success' && byName.tmpManifestOk.rowCount === 3 && !byName.tmpManifestOk.result,
      JSON.stringify(byName.tmpManifestOk));
    check('manifest.ok matches the report', content.ok === false);
    DriveApp.getFileById(report.manifest.fileId).setTrashed(true);
  });
}


// A Drive write failure (bad folderId) must not throw out of cli() and
// must not flip report.ok - best-effort by design.
function testManifestWriteFailureDoesNotThrow() {
  withTemporaryNodes({ notsobigdataManifest: { folderId: 'this-is-not-a-real-folder-id' } }, function () {
    var report = NotSoBigData.cli('run --select extractSheets');
    check('manifest reports the write error', report.manifest.written === false && report.manifest.reason === 'error' && !!report.manifest.error,
      JSON.stringify(report.manifest));
    check('report.ok is unaffected by the manifest failure', report.ok === true);
  });
}


// list is a dry run - nothing executed, so there is nothing worth
// recording, and no manifest field should even appear.
function testManifestNotWrittenOnList() {
  var report = NotSoBigData.cli('list');
  check('list has no manifest field', report.manifest === undefined, JSON.stringify(report.manifest));
}
