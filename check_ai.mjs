import dotenv from 'dotenv';
dotenv.config();
import { GoogleGenAI } from '@google/genai';

console.log('\n========================================');
console.log('🔍 AI PROVIDER DIAGNOSTIC TOOL');
console.log('========================================\n');

// 1. Check Groq
const groqKey = (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
if (!groqKey) {
    console.log('ℹ️  GROQ_API_KEY is not set in .env');
} else {
    console.log(`🔑 GROQ_API_KEY detected (${groqKey.slice(0, 8)}...${groqKey.slice(-4)})`);
    try {
        console.log('📡 Fetching available Groq models from API...');
        const res = await fetch('https://api.groq.com/openai/v1/models', {
            headers: { 'Authorization': `Bearer ${groqKey}` }
        });
        if (res.ok) {
            const data = await res.json();
            const models = (data.data || []).map(m => m.id);
            console.log('✅ Groq Key is VALID!');
            console.log('📋 Available models on your Groq account:');
            models.forEach(m => console.log(`   • ${m}`));

            // Test a quick generation
            const chatModel = models.find(m => m.includes('llama-3.3') || m.includes('llama-3.1') || m.includes('llama3') || m.includes('mixtral')) || models[0];
            if (chatModel) {
                console.log(`\n🧪 Testing generation with model: ${chatModel}...`);
                const testRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${groqKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        model: chatModel,
                        messages: [{ role: 'user', content: 'Say hello in 3 words' }],
                        max_tokens: 20
                    })
                });
                if (testRes.ok) {
                    const testJson = await testRes.json();
                    console.log('🎉 Groq test SUCCESS! Output:', testJson.choices?.[0]?.message?.content);
                } else {
                    console.log('❌ Groq test generation failed:', await testRes.text());
                }
            }
        } else {
            console.log(`❌ Groq API returned error ${res.status}:`, await res.text());
        }
    } catch (err) {
        console.log('❌ Error connecting to Groq:', err.message);
    }
}

console.log('\n----------------------------------------');

// 2. Check Gemini
const geminiKeys = (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
if (!geminiKeys.length) {
    console.log('ℹ️  GEMINI_API_KEY is not set in .env');
} else {
    console.log(`🔑 Found ${geminiKeys.length} Gemini key(s).`);
    for (let i = 0; i < geminiKeys.length; i++) {
        const key = geminiKeys[i];
        console.log(`\nTesting Gemini Key ${i + 1} (${key.slice(0, 8)}...):`);
        const client = new GoogleGenAI({ apiKey: key });
        for (const model of ['gemini-3.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash']) {
            try {
                const res = await client.models.generateContent({
                    model,
                    contents: 'Reply in 2 words'
                });
                console.log(`   ✅ [${model}] SUCCESS: ${res.text?.trim()}`);
                break;
            } catch (e) {
                console.log(`   ❌ [${model}] FAILED: ${e.message?.slice(0, 100)}...`);
            }
        }
    }
}

console.log('\n========================================\n');
