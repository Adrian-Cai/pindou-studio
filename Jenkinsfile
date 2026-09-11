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
                    command -v psql > /dev/null
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
                    mkdir -p "$DEPLOY_DIR/sql"
                    cp deploy/compose.yaml "$DEPLOY_DIR/compose.yaml"
                    cp server/sql/*.sql "$DEPLOY_DIR/sql/"

                    # 生产库是 DB_HOST 指向的外部实例，进 postgres 容器执行只会打到空库；
                    # 去掉可选引号后导出 DB_ 变量，第二个 sed 把 \$ 与反引号转成字面量，
                    # 否则密码里的 \$ 会被 eval 二次展开
                    set -a
                    eval "$(grep -E '^DB_[A-Z_]+=' "$RUNTIME_ENV_FILE" \
                      | sed -E 's/^([A-Z_]+)="?([^"]*)"?$/\1="\2"/' \
                      | sed -e 's/\\$/\\\$/g' -e 's/`/\\`/g')"
                    set +a
                    for key in DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD; do
                        eval "value=\${$key:-}"
                        test -n "$value" || {
                            echo "$RUNTIME_ENV_FILE 缺少 $key，无法连接生产库执行迁移"
                            exit 1
                        }
                    done

                    [ -n "$(ls -1 "$DEPLOY_DIR"/sql/[0-9][0-9][0-9]_*.sql 2>/dev/null)" ] || {
                        echo "缺少 $DEPLOY_DIR/sql 迁移脚本"
                        exit 1
                    }
                    for migration in "$DEPLOY_DIR"/sql/[0-9][0-9][0-9]_*.sql; do
                        echo "执行迁移 $(basename "$migration")"
                        PGPASSWORD="$DB_PASSWORD" psql \
                          -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
                          -v ON_ERROR_STOP=1 -f "$migration"
                    done

                    cd "$DEPLOY_DIR"
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
