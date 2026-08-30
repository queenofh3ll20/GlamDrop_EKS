# --- Security Groups per Amazon EKS & Servizi Gestiti ---

# --- 1. Security Group per il Cluster Control Plane Amazon EKS ---

resource "aws_security_group" "eks_cluster" {
  name        = "${var.project_name}-eks-cluster-sg"
  description = "Security Group per il Control Plane di Amazon EKS"
  vpc_id      = aws_vpc.main.id

  # Traffico in uscita verso i nodi worker e internet
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-eks-cluster-sg"
  }
}

# --- 2. Security Group per i Nodi Worker EKS Managed Node Group ---

resource "aws_security_group" "eks_nodes" {
  name        = "${var.project_name}-eks-nodes-sg"
  description = "Security Group per i nodi worker del cluster Amazon EKS"
  vpc_id      = aws_vpc.main.id

  # NodePort Ingress solo dall'Application Load Balancer (ALB)
  ingress {
    description     = "NodePort Ingress only from ALB"
    from_port       = 30000
    to_port         = 32767
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Comunicazione completa intra-cluster e intra-VPC (Kubelet, CNI, CoreDNS, Kube API)
  ingress {
    description = "All VPC intra-cluster traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  ingress {
    description = "Inter-node self traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  ingress {
    description     = "Cluster Control Plane to Node communication"
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.eks_cluster.id]
  }

  # Egress completo verso Internet (per container images, API AWS, pacchetti)
  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name                                                = "${var.project_name}-eks-nodes-sg"
    "kubernetes.io/cluster/${var.project_name}-cluster" = "owned"
  }
}

# Regole per il Security Group Primario creato automaticamente da EKS
resource "aws_security_group_rule" "eks_cluster_alb_nodeport" {
  description              = "Allow ALB to access NodePort on EKS worker nodes"
  type                     = "ingress"
  from_port                = 30000
  to_port                  = 32767
  protocol                 = "tcp"
  security_group_id        = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  source_security_group_id = aws_security_group.alb.id
}

resource "aws_security_group_rule" "eks_cluster_intra_vpc" {
  description       = "Allow all intra-VPC traffic to EKS cluster/nodes"
  type              = "ingress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  cidr_blocks       = [aws_vpc.main.cidr_block]
}

# Regola aggiuntiva per consentire ai nodi di comunicare con la Kube API del Control Plane
resource "aws_security_group_rule" "cluster_ingress_node_https" {
  description              = "Allow pods/nodes to communicate with the cluster API Server"
  type                     = "ingress"
  from_port                = 443
  to_port                  = 443
  protocol                 = "tcp"
  security_group_id        = aws_security_group.eks_cluster.id
  source_security_group_id = aws_security_group.eks_nodes.id
}

# --- 3. Security Group per Application Load Balancer ---

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-alb-sg"
  description = "Security Group per Application Load Balancer pubblico"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from Internet and CloudFront"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS from Internet and CloudFront"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "Allow all outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-alb-sg"
  }
}

# --- 4. Security Group per RDS PostgreSQL ---

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds-sg"
  description = "Security Group per RDS PostgreSQL"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from EKS nodes"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id, aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-rds-sg"
  }
}

# --- 5. Security Group per ElastiCache Redis ---

resource "aws_security_group" "elasticache" {
  name        = "${var.project_name}-elasticache-sg"
  description = "Security Group per ElastiCache Redis"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from EKS nodes"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id, aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-elasticache-sg"
  }
}

# --- 6. Security Group per Amazon MQ for RabbitMQ ---

resource "aws_security_group" "amazon_mq" {
  name        = "${var.project_name}-mq-sg"
  description = "Security Group per Amazon MQ for RabbitMQ"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "AMQPS TLS from EKS nodes"
    from_port       = 5671
    to_port         = 5671
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id, aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  ingress {
    description     = "RabbitMQ Web Console HTTPS from EKS nodes"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.eks_nodes.id, aws_eks_cluster.main.vpc_config[0].cluster_security_group_id]
  }

  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project_name}-mq-sg"
  }
}
