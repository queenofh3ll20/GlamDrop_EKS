# --- Amazon EKS Cluster & Managed Node Group (v1.36) ---

# --- 1. EKS Control Plane Cluster (v1.36 Gestito da AWS) ---

resource "aws_eks_cluster" "main" {
  name     = "${var.project_name}-cluster"
  version  = var.eks_version
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids              = [aws_subnet.public_1.id, aws_subnet.public_2.id, aws_subnet.private_1.id, aws_subnet.private_2.id]
    endpoint_private_access = true
    endpoint_public_access  = true
    security_group_ids      = [aws_security_group.eks_cluster.id]
  }

  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  depends_on = [
    aws_iam_role_policy_attachment.eks_cluster_policy,
    aws_iam_role_policy_attachment.eks_vpc_resource_controller
  ]

  tags = {
    Name = "${var.project_name}-cluster"
  }
}

# --- 2. EKS Cluster Add-ons Essenziali ---

resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "kube-proxy"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "coredns"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.workers]
}

# --- 3. EKS Managed Node Group (Worker Nodes v1.36) ---

resource "aws_eks_node_group" "workers" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.project_name}-workers"
  node_role_arn   = aws_iam_role.eks_node_role.arn
  subnet_ids      = [aws_subnet.public_1.id, aws_subnet.public_2.id]
  version         = var.eks_version

  scaling_config {
    desired_size = var.worker_count
    min_size     = var.asg_min_size
    max_size     = var.asg_max_size
  }

  instance_types = [var.instance_type]
  disk_size      = var.root_volume_size
  capacity_type  = "ON_DEMAND"

  update_config {
    max_unavailable = 1
  }

  tags = {
    Name                                                = "${var.project_name}-worker"
    Role                                                = "worker"
    "kubernetes.io/cluster/${var.project_name}-cluster" = "owned"
  }

  depends_on = [
    aws_iam_role_policy_attachment.eks_worker_node_policy,
    aws_iam_role_policy_attachment.eks_cni_policy,
    aws_iam_role_policy_attachment.eks_ecr_read_only,
    aws_iam_role_policy_attachment.eks_ssm_managed_instance_core
  ]
}

# --- 4. Registrazione Automatica dell'ASG dei Nodi Worker nel Target Group ALB ---

resource "aws_autoscaling_attachment" "eks_workers_alb" {
  autoscaling_group_name = aws_eks_node_group.workers.resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.k8s_ingress.arn
}
