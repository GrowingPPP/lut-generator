# CHROMA — 松下 LUT 生成器

VENV := .venv
BACKEND := backend
FRONTEND := frontend

MYSQL_USER ?= root
MYSQL_PASSWORD ?= 123456
MYSQL_DATABASE ?= chroma

BACKEND_PID := .backend.pid
FRONTEND_PID := .frontend.pid

.PHONY: help install db-init backend frontend dev stop restart test test-frontend test-parity check build clean

help: ## 显示所有可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## 安装前后端依赖
	@echo "安装后端依赖..."
	@test -d $(VENV) || python3 -m venv $(VENV)
	@$(VENV)/bin/pip install -r $(BACKEND)/requirements.txt
	@echo "安装前端依赖..."
	@cd $(FRONTEND) && npm install

db-init: ## 创建 MySQL 数据库
	@mysql -u $(MYSQL_USER) -p$(MYSQL_PASSWORD) -e "CREATE DATABASE IF NOT EXISTS $(MYSQL_DATABASE) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
	@echo "数据库 $(MYSQL_DATABASE) 就绪"

backend: ## 启动后端(后台,端口 8000)
	@if [ -f $(BACKEND_PID) ] && kill -0 `cat $(BACKEND_PID)` 2>/dev/null; then \
		echo "后端已在运行 (PID `cat $(BACKEND_PID)`)"; \
	else \
		cd $(BACKEND) && nohup ../$(VENV)/bin/uvicorn api.main:app --port 8000 > /tmp/chroma-backend.log 2>&1 & \
		echo $$! > ../$(BACKEND_PID); \
		echo "后端已启动 (PID `cat ../$(BACKEND_PID)`, 日志 /tmp/chroma-backend.log)"; \
	fi

frontend: ## 启动前端(后台,端口 5173)
	@if [ -f $(FRONTEND_PID) ] && kill -0 `cat $(FRONTEND_PID)` 2>/dev/null; then \
		echo "前端已在运行 (PID `cat $(FRONTEND_PID)`)"; \
	else \
		cd $(FRONTEND) && nohup npm run dev > /tmp/chroma-frontend.log 2>&1 & \
		echo $$! > ../$(FRONTEND_PID); \
		echo "前端已启动 (PID `cat ../$(FRONTEND_PID)`, 日志 /tmp/chroma-frontend.log)"; \
	fi

dev: ## 启动前后端(后台)
	@$(MAKE) backend
	@$(MAKE) frontend
	@echo "访问 http://localhost:5173"

stop: ## 停止前后端
	@echo "停止后端..."
	@if [ -f $(BACKEND_PID) ]; then kill `cat $(BACKEND_PID)` 2>/dev/null || true; rm -f $(BACKEND_PID); fi
	@pkill -f "uvicorn api.main" 2>/dev/null || true
	@echo "停止前端..."
	@if [ -f $(FRONTEND_PID) ]; then kill `cat $(FRONTEND_PID)` 2>/dev/null || true; rm -f $(FRONTEND_PID); fi
	@pkill -f "vite" 2>/dev/null || true
	@echo "已停止"

restart: stop dev ## 重启前后端

test: ## 运行后端测试
	@cd $(BACKEND) && ../$(VENV)/bin/python -m pytest tests/ -q

test-parity: ## 前后端引擎数学一致性校验(含 .cube 序列化)
	@cd $(BACKEND) && ../$(VENV)/bin/python scripts/gen_golden.py
	@cd $(FRONTEND) && node scripts/check_parity.mjs
	@cd $(FRONTEND) && node scripts/check_cube_parity.mjs

test-frontend: ## 前端纯函数测试(Node 内置 test runner,零依赖)
	@cd $(FRONTEND) && npm test

check: test test-frontend test-parity ## 跑全部校验(后端 + 前端 + 一致性)

build: ## 构建前端产物到 frontend/dist
	@cd $(FRONTEND) && npm run build

clean: ## 清理运行时文件
	@rm -f $(BACKEND_PID) $(FRONTEND_PID)
	@rm -rf $(BACKEND)/data
	@rm -rf $(BACKEND)/.pytest_cache
	@find $(BACKEND) -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
