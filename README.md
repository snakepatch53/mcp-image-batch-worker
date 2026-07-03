### MCP Image Batch Worker

_opencode_:

```json
    "mcp-image-batch-worker": {
        "enabled": true,
        "type": "local",
        "command": ["pnpm", "run", "dev"],
        "cwd": "/home/harold-msi/.local/bin/mcps/mcp-image-batch-worker",
        "environment": {
            "LMSTUDIO_API_BASE": "http://127.0.0.1:1234/v1",
            "LMSTUDIO_MODEL": "gemma-4-12b-it-qat",
            "LMSTUDIO_TEMPERATURE": "0",
            "LMSTUDIO_MAX_TOKENS": "300"
        },
        "timeout": 180000
    },
```

## MCP Referidos:

### MCP Image Optimizer

_Github_: https://github.com/piephai/mcp-image-optimizer

_Install_:

```
pnpm install -g mcp-image-optimizer
```

_opencode_:

```json
    "mcp-image-optimizer": {
        "enabled": true,
        "type": "local",
        "command": ["mcp-image-optimizer"]
    }
```
