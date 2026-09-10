pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    environment {
        IMAGE_REPO = 'docker.cnb.cool/imacaiy/pindou-studio'
        CNB_REGISTRY_USER = 'cnb'
        DEPLOY_DIR = '/opt/pindou/deploy'
        RUNTIME_ENV_FILE = '/opt/pindou/config/api.env'
    }

    stages {
        stage('准备部署版本') {
            steps {
                script {
                    env.IMAGE_TAG = sh(
                        script: 'git rev-parse --short=8 HEAD',
                        returnStdout: true
                    ).trim()
                }
                sh '''
                    set -eu
                    test -n "$IMAGE_TAG"
                    test -r "$RUNTIME_ENV_FILE"
                    test -f deploy/compose.yaml
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

        stage('部署后端') {
            steps {
                sh '''
                    set -eu
                    mkdir -p "$DEPLOY_DIR"
                    cp deploy/compose.yaml "$DEPLOY_DIR/compose.yaml"
                    cp server/sql/008_orders_user_created_index.sql \
                      "$DEPLOY_DIR/008_orders_user_created_index.sql"

                    cd "$DEPLOY_DIR"
                    IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                      docker compose --env-file "$RUNTIME_ENV_FILE" \
                        up -d --wait --wait-timeout 120 postgres
                    IMAGE_REPO="$IMAGE_REPO" IMAGE_TAG="$IMAGE_TAG" \
                      docker compose --env-file "$RUNTIME_ENV_FILE" exec -T postgres \
                        sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
                        < "$DEPLOY_DIR/008_orders_user_created_index.sql"
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
