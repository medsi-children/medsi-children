const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
test('psychotherapy formatter retains headings and bullet lists for unstructured reports',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../parents/psychology-format.js'),'utf8');
 const window={},document={readyState:'loading',addEventListener(){}};
 vm.runInNewContext(source,{window,document});
 const f=window.MedsiPsychologyFormatter;
 assert.ok(f);
 const parts=f.plainParts('Этап занятия:\n• Приветствие\n• Практическое упражнение');
 assert.deepEqual(Array.from(parts.map(p=>p.type)),['heading','list']);
 assert.equal(parts[1].items.length,2);
 const parsed=f.parse('Тема: Эмоции\n\n1. Разогрев: Назвали чувства');
 assert.equal(parsed.meta.length,1);
 assert.equal(parsed.sections.length,1);
});
