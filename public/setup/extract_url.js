const fs = require('fs');
const content = fs.readFileSync('C:/Users/Dan/.gemini/antigravity-ide/brain/2b090fc9-856a-4507-a5a1-13d87fea371b/.system_generated/steps/187/content.md', 'utf8');

const jsonStr = content.split('\n').slice(8).join('\n');
const startIdx = jsonStr.indexOf('{"info"');
if (startIdx !== -1) {
    const rawJson = jsonStr.substring(startIdx);
    // Replace unescaped backslashes and control characters that break JSON parsing
    const cleanStr = rawJson.replace(/\\/g, '\\\\').replace(/[\x00-\x1F\x7F]/g, ' ');
    try {
        const data = JSON.parse(cleanStr);
        if (data.releases && data.releases["1.2.0"]) {
             data.releases["1.2.0"].forEach(f => {
                  console.log(`${f.filename} -> ${f.url}`);
             });
        } else {
             console.log("No 1.2.0 releases key found");
        }
    } catch (e) {
        console.error("JSON parse error:", e.message);
    }
} else {
    console.log("JSON not found");
}
