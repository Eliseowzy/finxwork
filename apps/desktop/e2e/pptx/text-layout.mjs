import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyTextLayout({ run, cdp, until, sleep, shotDir, textSample }) {
  fs.mkdirSync(shotDir, { recursive: true });
  const results = [];
  const canvas = '[data-testid="pptx-slide-canvas"]';
  async function key(key, modifiers = 0, text) {
    const code=key.length===1 ? `Key${key.toUpperCase()}` : key;
    const windowsVirtualKeyCode=({Enter:13,Home:36,End:35,ArrowRight:39,ArrowLeft:37,z:90,b:66})[key] ?? 0;
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, modifiers });
    if (text) await cdp('Input.dispatchKeyEvent', { type: 'char', key, code, windowsVirtualKeyCode, text, modifiers });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode, modifiers });
  }
  async function focus(y = .18) {
    const r = await run(`(()=>{const r=document.querySelector('${canvas}').getBoundingClientRect();return {x:r.x+r.width*.5,y:r.y+r.height*${y}}})()`);
    for (const clickCount of [1, 2]) for (const type of ['mousePressed', 'mouseReleased'])
      await cdp('Input.dispatchMouseEvent', { type, ...r, button: 'left', clickCount });
    await sleep(150);
    await key('End', 4);
    await run('window.smoke.doc.prepare()');
  }
  const sizes = () => run("Array.from(document.querySelectorAll('select,input,button')).map(s=>s.value || s.textContent.trim())");
  async function ink() {
    return run(`(()=>{const c=document.querySelector('${canvas}'),{width:w,height:h}=c,d=c.getContext('2d').getImageData(0,0,w,h).data;let left=w,right=-1,top=h,bottom=-1;for(let y=Math.floor(h*.08);y<h*.39;y++)for(let x=Math.floor(w*.06);x<w*.94;x++){const i=(y*w+x)*4;if(d[i]<90&&d[i+1]<110&&d[i+2]<140&&d[i+3]>200){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}}return {left,right,top,bottom,width:right-left+1,height:bottom-top+1,canvasWidth:w}})()`);
  }
  async function stableInk() {
    let previous;
    for (let i=0;i<60;i++) {
      const next = await ink();
      if (previous && JSON.stringify(previous) === JSON.stringify(next) && next.width > 0) return next;
      previous=next;
      await sleep(100);
    }
    throw new Error('Text did not reach a stable painted frame');
  }
  async function save() {
    await run('window.smoke.doc.flush()');
    await until('!window.smoke.doc.dirty', 'text layout saved');
  }
  async function reopen() {
    await run('window.smoke.open()');
    await until('!!window.smoke.doc.serialize', 'text layout reopened');
    await stableInk();
  }
  async function ime(text) {
    for (const char of text) {
      await cdp('Input.imeSetComposition', { text: char, selectionStart: char.length, selectionEnd: char.length });
      await cdp('Input.insertText', { text: char });
      await sleep(100);
    }
    await stableInk();
  }
  async function serializedText() {
    return JSON.parse(await run('window.smoke.text()')).slides[0].shapes[0];
  }
  async function check(name, test, variant = "default") {
    try {
      await run(`fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'test/reset',params:{variant:${JSON.stringify(variant)}}})}).then(r=>{if(!r.ok)throw Error('reset failed')})`);
      await reopen();
      await focus(variant === "sample" ? .10 : .18);
      await test();
      results.push({ name, status: 'passed' });
    } catch (error) {
      results.push({ name, status: 'failed', error: error.message });
    }
    const saved=await run("fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'pptx/read',params:{}})}).then(r=>r.json())");
    fs.writeFileSync(path.join(shotDir,`${name}.pptx`),Buffer.from(saved.data,'base64'));
    fs.writeFileSync(path.join(shotDir, `${name}.png`), Buffer.from((await cdp('Page.captureScreenshot', {format:'png'})).data, 'base64'));
    console.log(`${results.at(-1).status.toUpperCase()}: ${name}${results.at(-1).error ? ': '+results.at(-1).error : ''}`);
  }
  await check('cjk-glyph-width', async () => {
    const before=await stableInk();
    await ime('杭州中文');
    const after=await stableInk();
    const em=44*96/72*after.canvasWidth/1280;
    assert.ok(after.width-before.width>em*4*.75, `Four Chinese characters advanced only ${after.width-before.width}px; expected at least ${em*3}px`);
    await save();
    fs.writeFileSync(path.join(shotDir,'cjk-snapshot.json'),await run('window.smoke.text()'));
    const saved=await serializedText();
    assert.equal(saved.text.paragraphs.flatMap(p=>p.runs).map(r=>r.text).join(''),'中文杭州中文','IME text missing or duplicated');
    await reopen();
    const reopened=await stableInk();
    assert.ok(Math.abs(reopened.width-after.width)<=2, `Text width changed after reopen: ${after.width} -> ${reopened.width}`);
  });
  for (const position of ['start', 'middle', 'end']) await check(`paragraph-${position}`, async () => {
    assert.ok((await sizes()).includes('44'), 'Fixture did not start at 44 pt');
    if (position !== 'end') await key('Home',4);
    if (position === 'middle') await key('ArrowRight');
    await key('Enter', 0, '\r');
    await sleep(300);
    const toolbar = await sizes();
    await ime('杭州');
    await save();
    const shape=await serializedText();
    fs.writeFileSync(path.join(shotDir,`paragraph-${position}-snapshot.json`),JSON.stringify(shape,null,2));
    const paragraphs=shape.text.paragraphs;
    const inserted=paragraphs.flatMap(p=>p.runs).filter(r=>r.text.includes('杭州'));
    const issues=[];
    if (!toolbar.includes('44')) issues.push('toolbar changed from 44 pt');
    if (paragraphs.length!==2) issues.push(`expected two paragraphs, got ${paragraphs.length}`);
    if (!inserted.length || inserted.some(r=>r.properties.fontSizePt!==44)) issues.push('saved Chinese text lost 44 pt');
    if (paragraphs.some(p=>p.properties.alignment!=='ctr')) issues.push('saved paragraph lost center alignment');
    await reopen();
    assert.deepEqual(await serializedText(),shape,'Saved text model changed after reopening');
    assert.deepEqual(issues,[],issues.join('; '));
  });
  await check('empty-paragraphs-roundtrip', async () => {
    for (let i=0;i<3;i++) await key('Enter',0,'\r');
    await save();
    fs.writeFileSync(path.join(shotDir,'empty-before-reopen.json'),JSON.stringify(await serializedText(),null,2));
    assert.equal((await serializedText()).text.paragraphs.length,4,'Rapid Enter commands did not create four paragraphs');
    await reopen();
    await focus();
    assert.ok((await sizes()).includes('44'),'Empty paragraph lost its 44 pt insertion format');
    await ime('杭州');
    await save();
    const paragraphs=(await serializedText()).text.paragraphs;
    assert.equal(paragraphs.length,4);
    assert.ok(paragraphs.every(p=>p.properties.alignment==='ctr'));
    assert.equal(paragraphs[3].runs.find(r=>r.text.includes('杭州')).properties.fontSizePt,44);
  });
  await check('shift-enter-soft-break', async () => {
    await key('Enter',8,'\r');
    await ime('杭州');
    await save();
    const paragraphs=(await serializedText()).text.paragraphs;
    assert.equal(paragraphs.length,1,'Shift+Enter created a paragraph instead of a soft line break');
    assert.ok(paragraphs[0].runs.some(r=>r.lineBreak),'Soft line break was not saved as a:br');
    assert.ok(paragraphs[0].runs.filter(r=>r.text).every(r=>r.properties.fontSizePt===44));
    await reopen();
    assert.equal((await serializedText()).text.paragraphs.length,1);
  });
  await check('selection-replacement', async () => {
    await key('Home',4);
    await key('End',12);
    await ime('杭州');
    await save();
    const runs=(await serializedText()).text.paragraphs[0].runs;
    assert.equal(runs.map(r=>r.text).join(''),'杭州');
    assert.ok(runs.every(r=>r.properties.fontSizePt===44));
  });
  await check('ime-cancellation', async () => {
    await save();
    const before=await serializedText();
    await cdp('Input.imeSetComposition',{text:'取消输入',selectionStart:4,selectionEnd:4});
    await cdp('Input.imeSetComposition',{text:'',selectionStart:0,selectionEnd:0});
    await save();
    assert.deepEqual(await serializedText(),before,'Cancelled composition modified the document');
  });
  await check('automatic-cjk-wrapping', async () => {
    const before=await stableInk();
    const text='中文文字布局自动换行验证中文文字布局自动换行验证';
    await cdp('Input.insertText',{text});
    const after=await stableInk();
    assert.ok(after.height>before.height*1.6,'Long CJK text did not wrap into another visual line');
    await save();
    const paragraphs=(await serializedText()).text.paragraphs;
    assert.equal(paragraphs.length,1,'Visual wrapping changed the paragraph structure');
    assert.equal(paragraphs[0].runs.map(r=>r.text).join(''),'中文'+text);
    await reopen();
    assert.ok(Math.abs((await stableInk()).height-after.height)<=2,'Wrapping changed after reopening');
  });
  for (const variant of ['list','inherit']) await check(`${variant}-split`, async () => {
    assert.ok((await sizes()).includes('44'),'Effective inherited font is not 44 pt');
    await key('Enter',0,'\r');
    await ime('杭州');
    await save();
    const paragraphs=(await serializedText()).text.paragraphs;
    assert.equal(paragraphs.length,2);
    if (variant==='inherit') {
      assert.ok(paragraphs.every(p=>p.properties.alignment===null || p.properties.alignment==='ctr'));
      const bounds=await stableInk();
      assert.ok(Math.abs((bounds.left+bounds.right)/2-bounds.canvasWidth*.4875)<bounds.canvasWidth*.025,'Inherited center alignment was not rendered');
    } else assert.ok(paragraphs.every(p=>p.properties.alignment==='ctr'));
    assert.ok(paragraphs[1].runs.filter(r=>r.text).every(r=>r.properties.fontSizePt===44));
    if (variant==='list') {
      assert.equal(paragraphs[1].properties.level,1);
      assert.deepEqual(paragraphs[1].properties.bullet,paragraphs[0].properties.bullet);
      assert.equal(paragraphs[1].properties.marginLeft,paragraphs[0].properties.marginLeft);
      assert.equal(paragraphs[1].properties.indent,paragraphs[0].properties.indent);
    }
    await reopen();
  },variant);
  await check('table-cell-split', async () => {
    assert.ok((await sizes()).includes('44'),'Table cell did not enter 44 pt text editing');
    await key('Enter',0,'\r');
    await ime('杭州');
    await save();
    function paragraphs(value) {
      if (!value || typeof value!=='object') return null;
      if (Array.isArray(value.paragraphs)) return value.paragraphs;
      for (const child of Object.values(value)) { const found=paragraphs(child); if (found) return found; }
      return null;
    }
    const cell=paragraphs(await serializedText());
    assert.equal(cell?.length,2);
    assert.ok(cell.every(p=>p.properties.alignment==='ctr'));
    assert.ok(cell[1].runs.filter(r=>r.text).every(r=>r.properties.fontSizePt===44));
    await reopen();
  },'table');
  await check('mixed-format-boundary', async () => {
    await key('Home',4);
    await key('ArrowRight');
    await run('window.smoke.doc.prepare()');
    const active=(await sizes()).filter(s=>s==='44'||s==='24');
    assert.equal(active.length,1);
    await key('Enter',0,'\r');
    await run('window.smoke.doc.prepare()');
    assert.ok((await sizes()).includes(active[0]),'Paragraph split changed the insertion format at a run boundary');
    await ime('杭州');
    await save();
    const paragraphs=(await serializedText()).text.paragraphs;
    assert.equal(paragraphs.length,2);
    assert.equal(paragraphs[1].runs.find(r=>r.text.includes('杭州')).properties.fontSizePt,Number(active[0]));
    await reopen();
  },'mixed');
  await check('mixed-text-undo-redo', async () => {
    await cdp('Input.insertText', {text:'Abc 123'});
    await ime('杭州');
    await save();
    const before=await serializedText();
    const undoRevision=await run('window.smoke.doc.revision');
    await key('z',4);
    await until(`window.smoke.doc.revision>${undoRevision}`,'undo document change');
    await save();
    assert.notDeepEqual(await serializedText(),before,'Undo did not change the document');
    const redoRevision=await run('window.smoke.doc.revision');
    await key('z',12);
    await until(`window.smoke.doc.revision>${redoRevision}`,'redo document change');
    await save();
    assert.deepEqual(await serializedText(),before,'Undo/redo changed the saved text or its formatting');
  });
  if (textSample) await check('user-sample-44pt-split', async () => {
    assert.ok((await sizes()).includes('44'));
    await key('Enter',0,'\r');
    await ime('杭州中文');
    await save();
    const paragraphs=(await serializedText()).text.paragraphs;
    assert.equal(paragraphs.length,2);
    assert.ok(paragraphs[1].runs.filter(r=>r.text).every(r=>r.properties.fontSizePt===44));
    const before=await stableInk();
    await reopen();
    const after=await stableInk();
    assert.ok(Math.abs(after.width-before.width)<=2);
  },'sample');
  fs.writeFileSync(path.join(shotDir,'text-layout-report.json'),JSON.stringify({results},null,2));
  assert.ok(results.every(r=>r.status==='passed'), `Text layout failures; inspect ${shotDir}/text-layout-report.json`);
}
