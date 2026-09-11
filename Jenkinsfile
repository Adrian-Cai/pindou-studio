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

                    psql_run() {
                        PGPASSWORD="$DB_PASSWORD" psql \
                          -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"
                    }

                    # 迁移含 ALTER TABLE / COMMENT ON / CREATE INDEX，PostgreSQL 要求执行者是被改表的
                    # owner，只给表级权限不够。DB_USER 不是 owner 时会等第一个 ALTER TABLE 才报
                    # must be owner of table，前面的建表已经落库、留下半套结构。
                    # 先探测 owner 并在启动迁移前失败，报错可直接定位到该改哪个账号
                    echo "检查迁移账号对 pindou_* 表的 owner 权限"
                    not_owned=$(psql_run -At -c "
                      SELECT tablename || ' (owner ' || tableowner || ')' FROM pg_tables
                       WHERE schemaname = current_schema()
                         AND tablename LIKE 'pindou_%'
                         AND tableowner <> current_user
                       ORDER BY tablename")
                    test -z "$not_owned" || {
                        echo "迁移账号 $DB_USER 不是以下 pindou_* 表的 owner，无法执行 ALTER TABLE："
                        echo "$not_owned"
                        echo "请将 $RUNTIME_ENV_FILE 的 DB_USER 改为这些表的 owner（或用 owner 账号手工跑完迁移）"
                        exit 1
                    }

                    for migration in "$DEPLOY_DIR"/sql/[0-9][0-9][0-9]_*.sql; do
                        echo "执行迁移 $(basename "$migration")"
                        psql_run -v ON_ERROR_STOP=1 -f "$migration" || {
                            echo "迁移 $(basename "$migration") 失败，已中断部署"
                            exit 1
                        }
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
