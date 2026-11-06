"""Generate a deterministic editable deck without depending on user documents."""
import sys
import re
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED, ZipInfo

variant = sys.argv[2] if len(sys.argv) > 2 else 'default'
source = Path(sys.argv[3]) if variant == 'sample' else Path(__file__).resolve().parents[4] / 'crates/finx-slide/tests/fixtures/text-layout.pptx'
with ZipFile(source) as archive, ZipFile(sys.argv[1], 'w', ZIP_DEFLATED) as output:
    for name in archive.namelist():
        data = archive.read(name)
        if variant == 'sample' and name in ['ppt/presentation.xml', 'ppt/slides/slide2.xml']:
            ET.register_namespace('p','http://schemas.openxmlformats.org/presentationml/2006/main')
            ET.register_namespace('a','http://schemas.openxmlformats.org/drawingml/2006/main')
            ET.register_namespace('r','http://schemas.openxmlformats.org/officeDocument/2006/relationships')
            root=ET.fromstring(data)
            if name == 'ppt/presentation.xml':
                ids=root.find('{http://schemas.openxmlformats.org/presentationml/2006/main}sldIdLst')
                slide=ids[1]; ids.remove(slide); ids.insert(0,slide)
            else:
                body=root.find('.//{http://schemas.openxmlformats.org/presentationml/2006/main}sp/{http://schemas.openxmlformats.org/presentationml/2006/main}txBody')
                paragraphs=body.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}p')
                for paragraph in paragraphs[1:]: body.remove(paragraph)
            data=ET.tostring(root,encoding='utf-8',xml_declaration=True)
        if variant != 'sample' and name == 'ppt/slides/slide1.xml':
            xml = data.decode().replace('Quarterly review', '中文')
            xml = xml.replace('sz="3600" b="1"', 'sz="4400" b="0"')
            xml = xml.replace('typeface="Arial"', 'typeface="Calibri"')
            xml = xml.replace('<a:p><a:r>', '<a:p><a:pPr algn="ctr"/><a:r>')
            xml = xml.replace('cy="914400"', 'cy="1828800"')
            if variant == 'mixed':
                xml = xml.replace('<a:t>中文</a:t></a:r>', '<a:t>中</a:t></a:r><a:r><a:rPr sz="2400" b="1"><a:latin typeface="Calibri"/></a:rPr><a:t>文</a:t></a:r>')
            if variant == 'list':
                xml = xml.replace('<a:pPr algn="ctr"/>', '<a:pPr algn="ctr" lvl="1" marL="342900" indent="-228600"><a:buChar char="•"/></a:pPr>')
            if variant == 'inherit':
                xml = xml.replace('sz="4400" ', '').replace('<a:pPr algn="ctr"/>', '')
                xml = xml.replace('<p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/>', '<p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr>')
            if variant == 'table':
                title = re.search(r'<p:sp><p:nvSpPr><p:cNvPr id="2".*?</p:sp>', xml).group()
                body = re.search(r'<p:txBody>(.*?)</p:txBody>', title).group(1)
                table = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="914400"/><a:ext cx="10058400" cy="1828800"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="10058400"/></a:tblGrid><a:tr h="1828800"><a:tc><a:txBody>' + body + '</a:txBody><a:tcPr/></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>'
                xml = xml.replace(title, table)
            data = xml.encode()
        if variant == 'inherit' and name == 'ppt/slideMasters/slideMaster1.xml':
            xml=data.decode()
            xml=re.sub(r'(<p:titleStyle><a:lvl1pPr)([^>]*)', lambda m: m[1]+re.sub(r' algn="[^"]*"','',m[2])+' algn="ctr"',xml)
            data=xml.encode()
        info = ZipInfo(name, (2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        output.writestr(info, data)
