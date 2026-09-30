// Reads the answer out of `pitroom show RUN` output: the text before DETAILS (with or without
// a "SUMMARY:" label: some models leave the label out), and the DETAILS text.
export function answerParts(txt) {
  const lines = txt.split('\n');
  let i = 2;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = [];
  for (; i < lines.length; i++) {
    if (/^(DETAILS|FILES CHANGED|VERIFICATION|OPEN ISSUES):/.test(lines[i]) || lines[i].startsWith('── ')) break;
    if (!/^warning:/.test(lines[i])) head.push(lines[i]);
  }
  const d = /^DETAILS:\s*(.*)$/m.exec(txt);
  return { summary: head.join(' ').trim().replace(/^.*SUMMARY:\s*/s, ''), details: d ? d[1].trim() : '' };
}
