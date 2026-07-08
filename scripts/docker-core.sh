#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER_NAME="${SVG_TRANSFORM_CORE_CONTAINER:-svg-transform-core}"
IMAGE_NAME="${SVG_TRANSFORM_CORE_IMAGE:-svg-transform-core:local}"
PORT="${PORT:-4310}"
WORKSPACE_DIR="${SVG_TRANSFORM_CORE_WORKSPACE:-$ROOT_DIR/workspace}"
MODEL_CONFIG="${SVG_TRANSFORM_CORE_MODEL_CONFIG:-$ROOT_DIR/.runtime/model-provider.json}"
ENV_FILE="${SVG_TRANSFORM_CORE_ENV_FILE:-}"

log() {
  printf '[docker-core] %s\n' "$*"
}

fail() {
  printf '[docker-core] ERROR: %s\n' "$*" >&2
  exit 1
}

ensure_docker() {
  command -v docker >/dev/null 2>&1 || fail "docker command not found"
  docker info >/dev/null 2>&1 || fail "Docker daemon is not running"
}

ensure_image() {
  docker image inspect "$IMAGE_NAME" >/dev/null 2>&1 || {
    log "image $IMAGE_NAME not found, building..."
    docker build -t "$IMAGE_NAME" "$ROOT_DIR"
  }
}

ensure_runtime_files() {
  mkdir -p "$WORKSPACE_DIR"
  if [ ! -f "$MODEL_CONFIG" ]; then
    fail "model config not found: $MODEL_CONFIG
Create it first:
  mkdir -p .runtime
  cp apps/server/config/model-provider.example.json .runtime/model-provider.json"
  fi
  if [ -n "$ENV_FILE" ] && [ ! -f "$ENV_FILE" ]; then
    fail "env file not found: $ENV_FILE"
  fi
}

container_exists() {
  docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || true)" = "true" ]
}

run_container() {
  if [ -n "$ENV_FILE" ]; then
    docker run -d \
      --name "$CONTAINER_NAME" \
      -p "$PORT:4310" \
      -v "$WORKSPACE_DIR:/app/workspace" \
      -v "$MODEL_CONFIG:/app/config/model-provider.json:ro" \
      --env-file "$ENV_FILE" \
      "$IMAGE_NAME"
  else
    docker run -d \
      --name "$CONTAINER_NAME" \
      -p "$PORT:4310" \
      -v "$WORKSPACE_DIR:/app/workspace" \
      -v "$MODEL_CONFIG:/app/config/model-provider.json:ro" \
      "$IMAGE_NAME"
  fi
}

wait_health() {
  local url="http://127.0.0.1:$PORT/health"
  for _ in $(seq 1 30); do
    if curl --max-time 2 -fsS "$url" >/dev/null 2>&1; then
      log "health ok: $url"
      return 0
    fi
    sleep 1
  done
  docker logs --tail 120 "$CONTAINER_NAME" || true
  fail "health check timed out: $url"
}

start_container() {
  ensure_docker
  ensure_image
  ensure_runtime_files

  if container_exists; then
    if container_running; then
      log "$CONTAINER_NAME is already running"
    else
      log "starting existing container: $CONTAINER_NAME"
      docker start "$CONTAINER_NAME" >/dev/null
    fi
  else
    log "creating container: $CONTAINER_NAME"
    run_container >/dev/null
  fi

  docker ps --filter "name=$CONTAINER_NAME" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
  wait_health
}

recreate_container() {
  ensure_docker
  ensure_image
  ensure_runtime_files
  if container_exists; then
    log "removing existing container: $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  log "creating container: $CONTAINER_NAME"
  run_container >/dev/null
  docker ps --filter "name=$CONTAINER_NAME" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
  wait_health
}

stop_container() {
  ensure_docker
  if container_exists; then
    docker stop "$CONTAINER_NAME" >/dev/null
    log "stopped: $CONTAINER_NAME"
  else
    log "container does not exist: $CONTAINER_NAME"
  fi
}

status_container() {
  ensure_docker
  docker ps -a --filter "name=$CONTAINER_NAME" --format 'table {{.ID}}\t{{.Image}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'
}

usage() {
  cat <<USAGE
Usage: scripts/docker-core.sh <command>

Commands:
  start       Start existing container or create it when missing
  recreate    Remove and recreate the container with current env/config
  stop        Stop the container
  restart     Stop then start the container
  status      Show container status
  logs        Follow container logs
  health      Check http://127.0.0.1:\$PORT/health

Environment:
  PORT                              Host port, default 4310
  SVG_TRANSFORM_CORE_CONTAINER       Container name, default svg-transform-core
  SVG_TRANSFORM_CORE_IMAGE           Image name, default svg-transform-core:local
  SVG_TRANSFORM_CORE_WORKSPACE       Host workspace dir, default ./workspace
  SVG_TRANSFORM_CORE_MODEL_CONFIG    Host model config, default ./.runtime/model-provider.json
  SVG_TRANSFORM_CORE_ENV_FILE        Optional env file passed to docker run
USAGE
}

command="${1:-start}"
case "$command" in
  start)
    start_container
    ;;
  recreate)
    recreate_container
    ;;
  stop)
    stop_container
    ;;
  restart)
    stop_container
    start_container
    ;;
  status)
    status_container
    ;;
  logs)
    ensure_docker
    docker logs -f "$CONTAINER_NAME"
    ;;
  health)
    curl --max-time 3 -fsS "http://127.0.0.1:$PORT/health"
    printf '\n'
    ;;
  help | --help | -h)
    usage
    ;;
  *)
    usage
    fail "unknown command: $command"
    ;;
esac
