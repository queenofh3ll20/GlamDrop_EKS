# --- Amazon CloudWatch Monitoring & Alarms ---

# --- 1. Allarme CPU Elevata per RDS PostgreSQL ---

resource "aws_cloudwatch_metric_alarm" "rds_high_cpu" {
  alarm_name          = "${var.project_name}-rds-high-cpu"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Allarme quando l'utilizzo CPU di RDS supera l'80%"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.identifier
  }

  tags = {
    Name = "${var.project_name}-rds-cpu-alarm"
  }
}

# --- 2. Allarme Spazio Disco Residuo Basso su RDS PostgreSQL (< 2 GB) ---

resource "aws_cloudwatch_metric_alarm" "rds_low_storage" {
  alarm_name          = "${var.project_name}-rds-low-storage"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 2147483648 # 2 GB in Bytes
  alarm_description   = "Allarme quando lo spazio disco residuo su RDS scende sotto i 2GB"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.identifier
  }

  tags = {
    Name = "${var.project_name}-rds-storage-alarm"
  }
}

# --- 3. Allarme 5XX su Application Load Balancer ---

resource "aws_cloudwatch_metric_alarm" "alb_5xx_errors" {
  alarm_name          = "${var.project_name}-alb-high-5xx"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "Allarme quando l'ALB genera più di 10 errori 5XX in 5 minuti"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
  }

  tags = {
    Name = "${var.project_name}-alb-5xx-alarm"
  }
}

# --- 4. Allarme CPU Elevata per i Nodi Worker EKS Managed Node Group ---

resource "aws_cloudwatch_metric_alarm" "workers_asg_high_cpu" {
  alarm_name          = "${var.project_name}-workers-asg-high-cpu"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/EC2"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "Allarme quando l'utilizzo medio CPU dei nodi Worker EKS supera l'80%"

  dimensions = {
    AutoScalingGroupName = aws_eks_node_group.workers.resources[0].autoscaling_groups[0].name
  }

  tags = {
    Name = "${var.project_name}-asg-cpu-alarm"
  }
}
