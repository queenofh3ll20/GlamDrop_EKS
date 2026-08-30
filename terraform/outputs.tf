# --- Terraform Outputs per Amazon EKS ---

output "aws_region" {
  description = "Regione AWS del deployment"
  value       = var.aws_region
}

# --- Amazon EKS Cluster & Node Group ---

output "eks_cluster_name" {
  description = "Nome del cluster Amazon EKS"
  value       = aws_eks_cluster.main.name
}

output "eks_cluster_endpoint" {
  description = "Endpoint API Server del cluster Amazon EKS"
  value       = aws_eks_cluster.main.endpoint
}

output "eks_cluster_version" {
  description = "Versione di Kubernetes in esecuzione su Amazon EKS"
  value       = aws_eks_cluster.main.version
}

output "eks_kubeconfig_command" {
  description = "Comando AWS CLI per configurare automaticamente kubectl per il cluster EKS"
  value       = "aws eks update-kubeconfig --name ${aws_eks_cluster.main.name} --region ${var.aws_region}"
}

output "eks_node_group_name" {
  description = "Nome dell'EKS Managed Node Group dei worker"
  value       = aws_eks_node_group.workers.node_group_name
}

output "eks_node_group_asg_name" {
  description = "Nome dell'Auto Scaling Group sottostante i nodi worker EKS"
  value       = aws_eks_node_group.workers.resources[0].autoscaling_groups[0].name
}

# --- AWS Application Load Balancer (ALB) ---

output "alb_dns_name" {
  description = "DNS pubblico dell'AWS Application Load Balancer"
  value       = aws_lb.main.dns_name
}

# --- Databases & Messaging ---

output "rds_postgres_endpoint" {
  description = "Endpoint di connessione a RDS PostgreSQL"
  value       = aws_db_instance.postgres.endpoint
}

output "rds_postgres_address" {
  description = "Host di connessione a RDS PostgreSQL"
  value       = aws_db_instance.postgres.address
}

output "rabbitmq_broker_endpoint" {
  description = "Endpoint di connessione AMQPS di Amazon MQ RabbitMQ"
  value       = length(aws_mq_broker.rabbitmq.instances) > 0 ? aws_mq_broker.rabbitmq.instances[0].endpoints[0] : ""
}

output "rabbitmq_broker_arn" {
  description = "ARN del broker Amazon MQ RabbitMQ"
  value       = aws_mq_broker.rabbitmq.arn
}

output "dynamodb_notifications_table" {
  description = "Nome tabella DynamoDB per lo storico notifiche"
  value       = aws_dynamodb_table.notifications.name
}

output "elasticache_redis_endpoint" {
  description = "Endpoint host di ElastiCache Redis"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

# --- Frontend & CloudFront ---

output "s3_frontend_bucket" {
  description = "Nome del bucket S3 per il deploy del frontend"
  value       = aws_s3_bucket.frontend.id
}

output "cloudfront_domain_name" {
  description = "URL pubblico CloudFront per accedere alla WebApp GlamDrop"
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "cloudfront_distribution_id" {
  description = "ID della distribuzione CloudFront per invalidazione cache"
  value       = aws_cloudfront_distribution.frontend.id
}

# --- ECR Repositories ---

output "ecr_repository_urls" {
  description = "URL dei repository ECR per i container"
  value       = { for k, v in aws_ecr_repository.services : k => v.repository_url }
}

output "ecr_auth_service_url" {
  description = "URL ECR repository per auth-service"
  value       = aws_ecr_repository.services["auth-service"].repository_url
}

output "ecr_booking_service_url" {
  description = "URL ECR repository per booking-service"
  value       = aws_ecr_repository.services["booking-service"].repository_url
}

output "ecr_drop_service_url" {
  description = "URL ECR repository per drop-service"
  value       = aws_ecr_repository.services["drop-service"].repository_url
}

output "ecr_notification_service_url" {
  description = "URL ECR repository per notification-service"
  value       = aws_ecr_repository.services["notification-service"].repository_url
}
