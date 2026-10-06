import type { TextEdit, NormRect } from './model';

/** Point geometry measured with the font embedded in the exported PDF. */
export function fitText(edit: TextEdit, pageWidth: number, pageHeight: number, measure: (text: string) => number) {
    const vertical = edit.angle % 180 !== 0;
    const limit = vertical ? pageHeight : pageWidth;
    const crossLimit = vertical ? pageWidth : pageHeight;
    const size = Number(edit.fontSize) || 12;
    const text = edit.text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
    const longest = Math.max(size, ...Array.from(text).filter(c => c !== '\n').map(measure));
    const start = Math.max(0, Math.min(vertical ? edit.rect.y*pageHeight : edit.rect.x*pageWidth, limit-longest-.5));
    const width = Math.min(limit-start, Math.max(size, ...text.split('\n').map(measure))+.5);
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
        let line = '';
        for (const c of Array.from(paragraph)) {
            if (line && measure(line+c) > width-.25) { lines.push(line); line = ''; }
            line += c;
        }
        lines.push(line);
    }
    const height = size*(1.31*lines.length+(edit.font === 'helv' ? .299 : .265625))+.25;
    const crossStart = Math.max(0, Math.min(vertical ? edit.rect.x*pageWidth : edit.rect.y*pageHeight, crossLimit-height));
    const rect: NormRect = vertical
        ? {x:crossStart/pageWidth,y:start/pageHeight,w:Math.min(height,crossLimit)/pageWidth,h:width/pageHeight}
        : {x:start/pageWidth,y:crossStart/pageHeight,w:width/pageWidth,h:Math.min(height,crossLimit)/pageHeight};
    return {rect,lines,overflow:height>crossLimit || longest+.5>limit};
}
