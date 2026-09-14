pipeline {
    // 使用 master 节点上配置的 production-docker 标签。
    agent { label 'production-docker' }

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    environment {
        IMAGE_REPO = 'docker.cnb.cool/imacaiy/pindou-studio'
        IMAGE_TAG = 'latest'
        CNB_REGISTRY_USER = 'cnb'
        DEPLOY_DIR = '/opt/pindou/deploy'
        RUNTIME_ENV_FILE = '/opt/pindou/config/api.env'
    }

    stages {
        stage('检查部署环境') {
            steps {
                sh '''
                    set -eu
                    test -r "$RUNTIME_ENV_FILE"
                    test -f deploy/compose.yaml
                    command -v docker > /dev/null
                    docker compose version > /dev/null
                    docker info > /dev/null
                    command -v curl > /dev/null
                '''
            }
        }

        stage('拉取 CNB 镜像') {
            steps {
                withCredentials([
                    string(
                        credentialsId: 'cnb-registry',
                        variable: 'CNB_TOKEN'
                    ),
                ]) {
                    sh '''
                        set -eu
                        echo "$CNB_TOKEN" | docker login docker.cnb.cool \
                          --username "$CNB_REGISTRY_USER" \
                          --password-stdin
                        docker pull "$IMAGE_REPO:$IMAGE_TAG"
                    '''
                }
            }
        }

        stage('更新 API') {
            steps {
                sh '''
                    set -eu
                    mkdir -p "$DEPLOY_DIR"
                    cp deploy/compose.yaml "$DEPLOY_DIR/compose.yaml"

                    cd "$DEPLOY_DIR"
                    docker compose --env-file "$RUNTIME_ENV_FILE" config --quiet
                    if ! IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                        docker compose --env-file "$RUNTIME_ENV_FILE" \
                          up -d --wait --wait-timeout 120 api; then
                        echo "API 容器未通过 Compose 健康等待，输出容器状态和最近日志"
                        IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                          docker compose --env-file "$RUNTIME_ENV_FILE" ps || true
                        docker inspect --format '{{json .State.Health}}' pindou-api || true
                        IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                          docker compose --env-file "$RUNTIME_ENV_FILE" \
                            logs --tail=100 api || true
                        exit 1
                    fi
                '''
            }
        }

        stage('健康检查') {
            steps {
                sh '''
                    set -eu
                    if ! curl --fail --silent --show-error \
                        --retry 20 --retry-delay 3 --retry-connrefused \
                        http://127.0.0.1:3100/health > /dev/null; then
                        echo "API 健康检查失败，输出容器状态和最近日志"
                        cd "$DEPLOY_DIR"
                        IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                          docker compose --env-file "$RUNTIME_ENV_FILE" ps || true
                        IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                          docker compose --env-file "$RUNTIME_ENV_FILE" \
                            logs --tail=100 api || true
                        exit 1
                    fi
                '''
            }
        }
    }

    post {
        always {
            sh 'docker logout docker.cnb.cool || true'
        }
    }
}
