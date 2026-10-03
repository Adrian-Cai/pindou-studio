pipeline {
    // 使用 master 节点上配置的 production-docker 标签。
    agent { label 'production-docker' }

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    environment {
        IMAGE_REPO = 'docker.cnb.cool/imacaiy/pindou-studio'
        CNB_REGISTRY_USER = 'cnb'
        DEPLOY_DIR = '/opt/pindou/deploy'
        RUNTIME_ENV_FILE = '/opt/pindou/config/api.env'
        STATE_DIR = '/opt/pindou/state'
        // 最终部署用的镜像 tag 由「拉取 CNB 镜像」阶段写入，后续阶段从文件读取。
        IMAGE_TAG_FILE = '.deploy-image-tag'
    }

    stages {
        stage('检查部署环境') {
            steps {
                sh '''
                    set -eu
                    test -r "$RUNTIME_ENV_FILE"
                    test -f deploy/compose.yaml
                    test -f deploy/deploy.sh
                    test -f deploy/rollback.sh
                    command -v docker > /dev/null
                    docker compose version > /dev/null
                    docker info > /dev/null
                    command -v curl > /dev/null
                '''
            }
        }

        stage('解析镜像 tag') {
            steps {
                sh '''
                    set -eu
                    git rev-parse HEAD > "$WORKSPACE/$IMAGE_TAG_FILE"
                    echo "本次部署对应的 commit：$(cat "$WORKSPACE/$IMAGE_TAG_FILE")"
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

                        FULL_TAG=$(cat "$WORKSPACE/$IMAGE_TAG_FILE")
                        SHORT_TAG=$(git rev-parse --short HEAD)

                        # 按 commit 精确拉取，而不是 latest：
                        # latest 与构建进度存在竞态，触发过早会部署到上一个提交的镜像。
                        # CNB 可能尚未构建完成，最多等待 10 分钟。
                        attempt=1
                        while [ "$attempt" -le 31 ]; do
                            for tag in "$FULL_TAG" "$SHORT_TAG"; do
                                if docker pull "$IMAGE_REPO:$tag"; then
                                    echo "$tag" > "$WORKSPACE/$IMAGE_TAG_FILE"
                                    echo "已拉取 $IMAGE_REPO:$tag"
                                    exit 0
                                fi
                            done
                            if [ "$attempt" -eq 31 ]; then
                                break
                            fi
                            echo "镜像尚未就绪，等待 CNB 构建（第 $attempt 次，间隔 20s）"
                            sleep 20
                            attempt=$((attempt + 1))
                        done

                        echo "等待 10 分钟后仍未拉到 $FULL_TAG 对应的镜像" >&2
                        exit 1
                    '''
                }
            }
        }

        stage('部署 API') {
            steps {
                sh '''
                    set -eu
                    IMAGE_TAG=$(cat "$WORKSPACE/$IMAGE_TAG_FILE")

                    mkdir -p "$DEPLOY_DIR" "$STATE_DIR"
                    cp deploy/compose.yaml deploy/deploy.sh deploy/rollback.sh "$DEPLOY_DIR/"
                    chmod +x "$DEPLOY_DIR/deploy.sh" "$DEPLOY_DIR/rollback.sh"

                    # 健康检查与失败自动回滚都在 deploy.sh 内完成。
                    IMAGE_REPO="$IMAGE_REPO" \
                    DEPLOY_DIR="$DEPLOY_DIR" \
                    RUNTIME_ENV_FILE="$RUNTIME_ENV_FILE" \
                    STATE_DIR="$STATE_DIR" \
                        sh "$DEPLOY_DIR/deploy.sh" "$IMAGE_TAG"
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
