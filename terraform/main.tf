terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project_name
      Environment = var.environment
      ManagedBy   = "Terraform"
      Platform    = "EKS"
    }
  }
}

# Disponibilità zone nella regione selezionata
data "aws_availability_zones" "available" {
  state = "available"
}

# Identità IAM del chiamante (per associazione automatica EKS Access Entry / Cluster Admin)
data "aws_caller_identity" "current" {}

# Suffix random per nomi globalmente unici (S3, ECR)
resource "random_string" "suffix" {
  length  = 6
  special = false
  upper   = false
}
