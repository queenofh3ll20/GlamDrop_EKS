resource "random_password" "generated_jwt_secret" {
  length  = 36
  special = false
}

resource "random_password" "generated_db_password" {
  length           = 20
  special          = true
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "random_password" "generated_redis_auth_token" {
  length  = 32
  special = false
}

resource "random_password" "generated_rabbitmq_password" {
  length      = 24
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "random_password" "generated_origin_verify_secret" {
  length  = 32
  special = false
}

locals {
  services             = ["auth-service", "booking-service", "drop-service", "notification-service"]
  jwt_secret           = var.jwt_secret != "" ? var.jwt_secret : random_password.generated_jwt_secret.result
  db_password          = var.db_password != "" ? var.db_password : random_password.generated_db_password.result
  redis_auth_token     = var.redis_auth_token != "" ? var.redis_auth_token : random_password.generated_redis_auth_token.result
  rabbitmq_password    = var.rabbitmq_password != "" ? var.rabbitmq_password : random_password.generated_rabbitmq_password.result
  origin_verify_secret = random_password.generated_origin_verify_secret.result
}

# --- 1. RDS PostgreSQL (auth-service, booking-service, drop-service) ---

resource "aws_db_subnet_group" "rds" {
  name       = "${var.project_name}-rds-subnet-group"
  subnet_ids = [aws_subnet.private_1.id, aws_subnet.private_2.id]

  tags = {
    Name = "${var.project_name}-rds-subnet-group"
  }
}

# Parameter Group per imporre la crittografia in-transit (SSL/TLS forzato)
resource "aws_db_parameter_group" "postgres" {
  name   = "${var.project_name}-pg15-params"
  family = "postgres15"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = {
    Name = "${var.project_name}-pg15-params"
  }
}

resource "aws_db_instance" "postgres" {
  identifier                 = "${var.project_name}-postgres-db"
  allocated_storage          = 20
  max_allocated_storage      = 20
  storage_type               = "gp3"
  storage_encrypted          = true # Encryption at-rest (KMS)
  engine                     = "postgres"
  engine_version             = "15"
  instance_class             = "db.t3.micro"
  db_name                    = var.db_name
  username                   = var.db_username
  password                   = local.db_password
  db_subnet_group_name       = aws_db_subnet_group.rds.name
  parameter_group_name       = aws_db_parameter_group.postgres.name
  vpc_security_group_ids     = [aws_security_group.rds.id]
  publicly_accessible        = false
  backup_retention_period    = 0 # Disabilitato per conformita con le restrizioni Free Tier
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true
  skip_final_snapshot        = true
  deletion_protection        = false

  tags = {
    Name = "${var.project_name}-postgres-db"
  }
}

# --- 2. Amazon MQ for RabbitMQ (Messaggistica AMQP Disaccoppiata) ---

resource "aws_mq_broker" "rabbitmq" {
  broker_name                = "${var.project_name}-rabbitmq"
  engine_type                = "RabbitMQ"
  engine_version             = "3.13"
  host_instance_type         = var.mq_instance_type
  auto_minor_version_upgrade = true
  deployment_mode            = "SINGLE_INSTANCE"
  publicly_accessible        = false
  subnet_ids                 = [aws_subnet.private_1.id]
  security_groups            = [aws_security_group.amazon_mq.id]

  user {
    username = "glamdrop"
    password = local.rabbitmq_password
  }

  tags = {
    Name = "${var.project_name}-rabbitmq"
  }
}

# --- 3. Amazon DynamoDB (notification-service) ---

resource "aws_dynamodb_table" "notifications" {
  name                        = "${var.project_name}-notifications"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "user_id"
  range_key                   = "timestamp"
  deletion_protection_enabled = false

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "timestamp"
    type = "S"
  }

  attribute {
    name = "status_scope"
    type = "S"
  }

  # Global Secondary Index per query cronologiche O(1) globali
  global_secondary_index {
    name            = "AllNotificationsIndex"
    hash_key        = "status_scope"
    range_key       = "timestamp"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = "${var.project_name}-notifications-table"
  }
}

# --- 4. Amazon ElastiCache Redis (drop-service Fast Cache & Locks) ---

resource "aws_elasticache_subnet_group" "redis" {
  name       = "${var.project_name}-redis-subnet-group"
  subnet_ids = [aws_subnet.private_1.id, aws_subnet.private_2.id]
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.project_name}-redis"
  description                = "ElastiCache Redis cluster for GlamDrop Drop Service with full encryption"
  node_type                  = "cache.t3.micro"
  num_cache_clusters         = 1
  port                       = 6379
  parameter_group_name       = "default.redis7"
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.elasticache.id]
  at_rest_encryption_enabled = true                   # Encryption at-rest
  transit_encryption_enabled = true                   # Encryption in-transit (TLS)
  auth_token                 = local.redis_auth_token # Dedicated Redis AUTH token
  auto_minor_version_upgrade = true
  apply_immediately          = true
  snapshot_retention_limit   = 0

  tags = {
    Name = "${var.project_name}-redis-cache"
  }
}

# --- 5. Amazon ECR (Registries Immagini Microservizi) ---

resource "aws_ecr_repository" "services" {
  for_each     = toset(local.services)
  name         = "${var.project_name}/${each.key}"
  force_delete = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    Name = "${var.project_name}-${each.key}-repo"
  }
}

# Lifecycle Policy per evitare accumulo di immagini e costi storage
resource "aws_ecr_lifecycle_policy" "services" {
  for_each   = toset(local.services)
  repository = aws_ecr_repository.services[each.key].name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Rimuovi immagini non taggate dopo 14 giorni"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Conserva solo le ultime 10 immagini taggate"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

# --- 6. AWS SSM Parameter Store (Secrets Centralizzati) ---

resource "aws_ssm_parameter" "jwt_secret" {
  name        = "/${var.project_name}/jwt_secret"
  description = "JWT Signing Secret"
  type        = "SecureString"
  value       = local.jwt_secret
  overwrite   = true
}

resource "aws_ssm_parameter" "db_password" {
  name        = "/${var.project_name}/db_password"
  description = "Master DB Password"
  type        = "SecureString"
  value       = local.db_password
  overwrite   = true
}

resource "aws_ssm_parameter" "redis_auth_token" {
  name        = "/${var.project_name}/redis_auth_token"
  description = "Redis ElastiCache Auth Token"
  type        = "SecureString"
  value       = local.redis_auth_token
  overwrite   = true
}

resource "aws_ssm_parameter" "rabbitmq_password" {
  name        = "/${var.project_name}/rabbitmq_password"
  description = "Amazon MQ RabbitMQ Password"
  type        = "SecureString"
  value       = local.rabbitmq_password
  overwrite   = true
}

resource "aws_ssm_parameter" "postgres_host" {
  name        = "/${var.project_name}/postgres_host"
  description = "PostgreSQL RDS Host Endpoint"
  type        = "String"
  value       = aws_db_instance.postgres.address
  overwrite   = true
}

resource "aws_ssm_parameter" "redis_host" {
  name        = "/${var.project_name}/redis_host"
  description = "Redis ElastiCache Primary Endpoint"
  type        = "String"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
  overwrite   = true
}

resource "aws_ssm_parameter" "redis_url" {
  name        = "/${var.project_name}/redis_url"
  description = "Redis ElastiCache Rediss TLS Connection URL"
  type        = "SecureString"
  value       = "rediss://:${urlencode(local.redis_auth_token)}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  overwrite   = true
}

resource "aws_ssm_parameter" "rabbitmq_url" {
  name        = "/${var.project_name}/rabbitmq_url"
  description = "Amazon MQ RabbitMQ AMQPS Connection URL"
  type        = "SecureString"
  value       = length(aws_mq_broker.rabbitmq.instances) > 0 ? replace(aws_mq_broker.rabbitmq.instances[0].endpoints[0], "amqps://", "amqps://glamdrop:${urlencode(local.rabbitmq_password)}@") : ""
  overwrite   = true
}

# --- 7. Generazione Automatica di k8s/secret.yaml con gli endpoint live ---

resource "local_file" "k8s_secret" {
  filename = "${path.module}/../k8s/secret.yaml"
  content  = <<-EOT
apiVersion: v1
kind: Secret
metadata:
  name: glamdrop-secrets
  namespace: glamdrop
type: Opaque
stringData:
  jwt-secret: "${local.jwt_secret}"
  postgres-host: "${aws_db_instance.postgres.address}"
  postgres-port: "5432"
  postgres-user: "${var.db_username}"
  postgres-password: "${local.db_password}"
  postgres-db: "${var.db_name}"
  redis-url: "rediss://:${urlencode(local.redis_auth_token)}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  redis-host: "${aws_elasticache_replication_group.redis.primary_endpoint_address}"
  redis-auth-token: "${local.redis_auth_token}"
  rabbitmq-url: "${length(aws_mq_broker.rabbitmq.instances) > 0 ? replace(aws_mq_broker.rabbitmq.instances[0].endpoints[0], "amqps://", "amqps://glamdrop:${urlencode(local.rabbitmq_password)}@") : ""}"
  rabbitmq-user: "glamdrop"
  rabbitmq-password: "${local.rabbitmq_password}"
  dynamodb-notifications-table: "${aws_dynamodb_table.notifications.name}"
  aws-region: "${var.aws_region}"
  auth-service-url: "http://auth-service:3001"
  booking-service-url: "http://booking-service:3002"
EOT
}
