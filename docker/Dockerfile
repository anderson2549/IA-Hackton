FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Dependencias base
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    git \
    ca-certificates \
    gnupg \
    lsb-release \
    build-essential \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Node.js 20 (requerido por Claude Code)
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# MCP Servers para el workflow
RUN npm install -g \
    @sentry/mcp-server \
    mcp-atlassian

# Ollama
RUN curl -fsSL https://ollama.com/install.sh | sh

WORKDIR /workspace

COPY entrypoint.sh /entrypoint.sh
COPY claude-settings.json /root/.claude/settings.json
RUN chmod +x /entrypoint.sh

EXPOSE 11434

ENTRYPOINT ["/entrypoint.sh"]
