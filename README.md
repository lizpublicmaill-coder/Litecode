# LiteChat
Lightweight multi-provider AI chat desktop app. No agent, no tools — just your API keys.

## Download (no setup)
Go to the **Actions** tab → latest "Build Windows exe" run → download the `LiteChat-portable` artifact.
Or push a tag (`git tag v1.0.0 && git push --tags`) and the .exe is attached to a **Release**.

## Build locally (Windows, Node.js 18+)
    npm install
    npm run build
Output: dist/LiteChat-1.0.0-portable.exe

Run without building: `npm start`

## Providers
- OpenAI-compatible: OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, Ollama, LM Studio...
  Base URL example: https://api.openai.com/v1
- Anthropic: Base URL https://api.anthropic.com
- Google Gemini (native API): Base URL https://generativelanguage.googleapis.com — get a key at aistudio.google.com
- The provider dialog has a **Preset** dropdown (Gemini, OpenAI, Anthropic, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, Fireworks, Perplexity, Cerebras, NVIDIA, Cohere, Moonshot, Zhipu, SiliconFlow, Ollama, LM Studio). Anything else that speaks the OpenAI format works via a custom URL.

## Notes
- Attach images with the 📎 button or by pasting. Images are resized to max 1568px and need a vision-capable model.
- "Fetch models" in the provider dialog lists models from the provider's /models endpoint.
- Markdown: headings, lists, bold/italic, inline code, code blocks (with Copy), links. Tables are not rendered.
- API keys are stored locally in the app's data folder (data.json), never uploaded anywhere except to your chosen provider.
