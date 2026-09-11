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
                    IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                      docker compose --env-file "$RUNTIME_ENV_FILE" \
                        up -d --wait --wait-timeout 120 api
                '''
            }
        }

        stage('健康检查') {
            steps {
                sh '''
                    set -eu
                    curl --fail --silent --show-error \
                      --retry 20 --retry-delay 3 --retry-connrefused \
                      http://127.0.0.1:3100/health > /dev/null
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
