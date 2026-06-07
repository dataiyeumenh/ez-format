@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\start-ai-local-desktop.ps1" ^
  -RepoRoot "%~dp0.." ^
  -GatewayPort 8010 ^
  -Model "qwen2.5:7b" ^
  -OllamaBaseUrl "http://127.0.0.1:11434" ^
  -ConverterPort 8000 ^
  -MisaTemplateDir "%~dp0..\converter\fixtures\templates"
