import zhCN from "@betteroffice/docx-i18n/zh-CN";

// What @betteroffice/docx-i18n 0.5.1's zh-CN leaves in English (the editor falls back to en for these):
// the context menu's 批注, revision cards, the zoom and font controls, the commands' reasons.
const missing: Record<string, string> = {
  "toolbar.break": "分隔符", "toolbar.sectionBreakNextPage": "分节符（下一页）", "toolbar.sectionBreakContinuous": "分节符（连续）", "toolbar.imageWrap.current": "当前",
  "formattingBar.commentsAndChanges": "批注与修订", "formattingBar.moreItems": "另外 {count} 项",
  "lineSpacing.label": "行距", "font.other": "其他", "font.documentFonts": "文档字体", "fontSize.selectAriaLabel": "选择字号",
  "zoom.zoomOut": "缩小", "zoom.zoomIn": "放大", "zoom.zoomLevel": "缩放",
  "dialogs.keyboardShortcuts.shortcuts.open": "打开", "dialogs.keyboardShortcuts.shortcuts.openDescription": "打开文档",
  "dialogs.objectGeometry.left": "左 (px)", "dialogs.objectGeometry.top": "上 (px)", "dialogs.objectGeometry.width": "宽 (px)", "dialogs.objectGeometry.height": "高 (px)",
  "revisions.paragraphMarkInserted": "插入了段落标记", "revisions.paragraphMarkDeleted": "删除了段落标记", "revisions.paragraphPropertiesChanged": "更改了段落格式",
  "revisions.rowInserted": "插入了行", "revisions.rowDeleted": "删除了行", "revisions.rowPropertiesChanged": "更改了行格式",
  "revisions.cellInserted": "插入了单元格", "revisions.cellDeleted": "删除了单元格", "revisions.cellMerged": "合并了单元格", "revisions.cellPropertiesChanged": "更改了单元格格式",
  "revisions.tablePropertiesChanged": "更改了表格格式", "revisions.tableInserted": "插入了表格", "revisions.tableDeleted": "删除了表格",
  "contextMenu.addComment": "批注", "contextMenu.resizeImage": "调整图片大小", "contextMenu.moveImage": "移动图片", "contextMenu.columnWidth": "列宽",
  "errors.stillOpening": "文档还在打开，准备好后即可输入。", "errors.failedToLoadDescription": "文件可能已损坏，或用到了编辑器暂不支持的内容。",
  "errors.editorUnavailable": "编辑器未能加载", "errors.editorUnavailableDescription": "请检查网络后重新载入。", "errors.reloadPage": "重新载入",
  "table.selectTable": "选择整个表格",
  "editor.documentInput": "文档输入", "editor.documentPreview": "文档预览", "editor.closeNote": "关闭注释", "editor.recoverableText": "可恢复的文字",
  "editor.dismissDraft": "放弃草稿", "editor.readDocumentText": "读取文档文字", "editor.documentText": "文档文字", "editor.previousText": "上一段文字", "editor.nextText": "下一段文字",
  "editor.addComment": "添加批注", "editor.noteProperties": "注释属性", "editor.recoverableTextNotice": "这段文字未能写入。请先复制保留，再放弃草稿。",
  "editor.documentTextUnavailable": "无法读取文档文字。", "editor.documentTextChanged": "文档文字已变化，请重新读取。",
  "imageOverlay.replaceImage": "替换图片…",
  "a11y.pageLabel": "第 {number} 页", "a11y.headerLabel": "页眉", "a11y.footerLabel": "页脚", "a11y.selected": "已选中", "a11y.selectionCleared": "已取消选择",
  "a11y.commentedText": "有批注的文字", "a11y.trackedInsertion": "修订：插入", "a11y.trackedDeletion": "修订：删除", "a11y.listItem": "列表项，第 {level} 级",
  "a11y.contentControl": "内容控件", "a11y.addRepeatingItem": "添加项", "a11y.removeRepeatingItem": "删除项",
  "commands.paragraphStyle": "段落样式", "commands.fontFamily": "字体", "commands.imageWrap": "文字环绕", "commands.editingMode": "编辑模式", "commands.review": "审阅",
  "commands.reviewPrevious": "上一处修订", "commands.reviewNext": "下一处修订", "commands.moreActions": "更多操作", "commands.customColor": "自定义颜色…",
  "commands.hexColor": "十六进制颜色，如 FF0000", "commands.customFontSize": "自定义字号…", "commands.fontSizePoints": "字号（磅）",
  "commands.reasons.editorUnavailable": "编辑器尚未就绪。", "commands.reasons.documentLoading": "文档仍在加载。", "commands.reasons.noDocument": "没有打开的文档。",
  "commands.reasons.readOnly": "此文档为只读。", "commands.reasons.viewingMode": "切换到“编辑”或“建议”后才能修改。", "commands.reasons.suggestingUnsupported": "这项修改无法记为修订建议。",
  "commands.reasons.selectionRequired": "请先在文档中放置光标。", "commands.reasons.unsupportedSelection": "此命令不能用于当前选区。", "commands.reasons.unsupportedStory": "编辑页眉、页脚或注释时不可用。",
  "commands.reasons.cannotOutdent": "此段落没有可减少的缩进。", "commands.reasons.nothingToUndo": "没有可撤销的操作。", "commands.reasons.nothingToRedo": "没有可重做的操作。",
  "commands.reasons.imageRequired": "请先选择图片。", "commands.reasons.tableRequired": "请先把光标放在表格中。", "commands.reasons.multipleCellsRequired": "请选择多个单元格。",
  "commands.reasons.cannotSplitCell": "此单元格无法拆分。", "commands.reasons.lastRow": "表格至少要有一行。", "commands.reasons.lastColumn": "表格至少要有一列。",
  "commands.reasons.revisionRequired": "请把光标放在修订处。", "commands.reasons.revisionNotFound": "这处修订已不存在。", "commands.reasons.noRevisions": "文档中没有修订。",
  "commands.reasons.controlledMode": "编辑模式由应用控制。", "commands.reasons.controlledSidebar": "批注栏由应用控制。", "commands.reasons.hostDisabled": "应用已关闭此功能。",
  "commands.reasons.unsupportedCommand": "暂不支持此操作。", "commands.reasons.tableOfContentsUnsupported": "暂不支持插入目录。", "commands.reasons.invalidArguments": "命令参数无效。",
  "commands.reasons.inputFailed": "之前的输入未能写入，此命令未执行。", "commands.reasons.documentReplaced": "命令执行前文档已变化。",
  "commands.reasons.targetChanged": "执行前内容已变化，请重试。", "commands.reasons.commandFailed": "命令未能完成。",
  "commands.reasons.permissionDenied": "应用未允许此插件使用该命令。", "commands.reasons.unsupportedPolicy": "插件暂不能运行此命令。",
  "commands.reasons.pluginUnavailable": "插件已停用。", "commands.reasons.aborted": "插件操作已取消。",
  "plugins.toolbarGroup": "插件", "plugins.panelTabs": "插件面板", "plugins.collapsePanel": "收起{title}", "plugins.expandPanel": "展开{title}",
};

function withMissing<T extends object>(base: T): T {
  const out = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(missing)) {
    const path = key.split(".");
    let node = out;
    for (const part of path.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>;
    node[path.at(-1)!] ??= value;
  }
  return out as T;
}

/** The editor's Chinese, complete. */
export const wordZhCN = withMissing(zhCN);
