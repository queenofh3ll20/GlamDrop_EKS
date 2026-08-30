#!/bin/bash
set -e

# Change directory to script location
cd "$(dirname "$0")"

# Ensure Windows PATH tools (terraform.exe, aws.exe, kubectl.exe, docker.exe) are available in PATH if running in Git Bash / MSYS
export PATH="$PATH:/c/Users/Hp/AppData/Local/Microsoft/WinGet/Packages/Hashicorp.Terraform_Microsoft.Winget.Source_8wekyb3d8bbwe:/c/Users/Hp/AppData/Local/Programs/Amazon/AWSCLIV2:/c/Program Files/Docker/Docker/resources/bin"

echo "=========================================================================="
echo "   [GlamDrop-EKS] Deploy su Amazon EKS v1.36 + S3/CloudFront"
echo "=========================================================================="

# --- FASE 1: Recupero informazioni da Terraform ---
echo "=== [1/5] Recupero parametri e credenziali da Terraform ==="
cd terraform

EKS_CLUSTER_NAME=$(terraform output -raw eks_cluster_name 2>/dev/null || terraform.exe output -raw eks_cluster_name 2>/dev/null || true)
AWS_REGION=$(terraform output -raw aws_region 2>/dev/null || terraform.exe output -raw aws_region 2>/dev/null || echo "eu-south-1")
S3_BUCKET=$(terraform output -raw s3_frontend_bucket 2>/dev/null || terraform.exe output -raw s3_frontend_bucket 2>/dev/null || true)
CLOUDFRONT_URL=$(terraform output -raw cloudfront_domain_name 2>/dev/null || terraform.exe output -raw cloudfront_domain_name 2>/dev/null || true)
CLOUDFRONT_DIST_ID=$(terraform output -raw cloudfront_distribution_id 2>/dev/null || terraform.exe output -raw cloudfront_distribution_id 2>/dev/null || true)

AUTH_ECR=$(terraform output -raw ecr_auth_service_url 2>/dev/null || terraform.exe output -raw ecr_auth_service_url 2>/dev/null || true)
BOOKING_ECR=$(terraform output -raw ecr_booking_service_url 2>/dev/null || terraform.exe output -raw ecr_booking_service_url 2>/dev/null || true)
DROP_ECR=$(terraform output -raw ecr_drop_service_url 2>/dev/null || terraform.exe output -raw ecr_drop_service_url 2>/dev/null || true)
NOTIF_ECR=$(terraform output -raw ecr_notification_service_url 2>/dev/null || terraform.exe output -raw ecr_notification_service_url 2>/dev/null || true)

cd ..

# Fallback automatico via AWS CLI se i parametri non sono nel tfstate locale
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text 2>/dev/null || aws.exe sts get-caller-identity --query "Account" --output text 2>/dev/null || true)
if [ -z "$EKS_CLUSTER_NAME" ] || [ "$EKS_CLUSTER_NAME" = "None" ]; then
  EKS_CLUSTER_NAME=$(aws eks list-clusters --region "$AWS_REGION" --query "clusters[?contains(@, 'glamdrop-eks')][0]" --output text 2>/dev/null || true)
  if [ -z "$EKS_CLUSTER_NAME" ] || [ "$EKS_CLUSTER_NAME" = "None" ]; then
    EKS_CLUSTER_NAME="glamdrop-eks-cluster"
  fi
fi
if [ -z "$S3_BUCKET" ] || [ "$S3_BUCKET" = "None" ]; then
  S3_BUCKET=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'glamdrop-eks-frontend')].Name" --output text 2>/dev/null || true | awk '{print $1}')
fi
if [ -z "$AUTH_ECR" ] && [ -n "$AWS_ACCOUNT_ID" ] && [ "$AWS_ACCOUNT_ID" != "None" ]; then
  AUTH_ECR="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/glamdrop-eks/auth-service"
  BOOKING_ECR="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/glamdrop-eks/booking-service"
  DROP_ECR="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/glamdrop-eks/drop-service"
  NOTIF_ECR="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/glamdrop-eks/notification-service"
fi
if [ -z "$CLOUDFRONT_URL" ] || [ -z "$CLOUDFRONT_DIST_ID" ] || [ "$CLOUDFRONT_DIST_ID" = "None" ]; then
  CLOUDFRONT_DIST_ID=$(aws cloudfront list-distributions --query "DistributionList.Items[?contains(Comment, 'glamdrop-eks')].Id | [0]" --output text 2>/dev/null || true)
  if [ "$CLOUDFRONT_DIST_ID" != "None" ] && [ -n "$CLOUDFRONT_DIST_ID" ]; then
    CLOUDFRONT_URL="https://$(aws cloudfront get-distribution --id "$CLOUDFRONT_DIST_ID" --query "Distribution.DomainName" --output text 2>/dev/null || true)"
  fi
fi

if [ -z "$EKS_CLUSTER_NAME" ]; then
  echo "[ERRORE] Impossibile determinare il cluster EKS. Verifica i Terraform output."
  exit 1
fi

echo "  -> EKS Cluster Name: ${EKS_CLUSTER_NAME}"
echo "  -> AWS Region: ${AWS_REGION}"
echo "  -> S3 Frontend Bucket: ${S3_BUCKET}"
echo "  -> CloudFront URL: ${CLOUDFRONT_URL}"
echo "  -> CloudFront Dist ID: ${CLOUDFRONT_DIST_ID}"
echo "  -> ECR Auth Service: ${AUTH_ECR}"

# --- FASE 2: Deploy Frontend su AWS S3 & CloudFront ---
echo ""
echo "=== [2/5] Deploy del Frontend su S3 e invalidazione CDN ==="
if [ -n "$S3_BUCKET" ] && [ "$S3_BUCKET" != "None" ]; then
  echo "  -> Sincronizzazione file statici su s3://${S3_BUCKET}..."
  aws s3 sync frontend/ "s3://${S3_BUCKET}/" --exclude "Dockerfile" --exclude "nginx.conf" --delete
  echo "  Frontend caricato con successo su S3."

  if [ -n "$CLOUDFRONT_DIST_ID" ] && [ "$CLOUDFRONT_DIST_ID" != "None" ]; then
    echo "  -> Invalidazione cache CloudFront per la distribuzione ${CLOUDFRONT_DIST_ID}..."
    aws cloudfront create-invalidation --distribution-id "$CLOUDFRONT_DIST_ID" --paths "/*" >/dev/null 2>&1 || true
    echo "  Invalidazione cache CloudFront richiesta."
  fi
else
  echo "  S3 bucket non configurato, salto deploy frontend."
fi

# --- FASE 3: Build & Push Immagini Docker su ECR (se Docker è presente) ---
if command -v docker &>/dev/null && [ -n "$AUTH_ECR" ]; then
  echo ""
  echo "=== [3/5] Build & Push immagini Docker su Amazon ECR ==="
  REGISTRY=$(echo "$AUTH_ECR" | cut -d'/' -f1)
  echo "  -> Autenticazione con Amazon ECR ($REGISTRY)..."
  aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null 2>&1 || true
  
  echo "  -> Compilazione & caricamento auth-service..."
  docker build --platform linux/amd64 -q -t "${AUTH_ECR}:v1.0.0" services/auth-service/
  docker push -q "${AUTH_ECR}:v1.0.0"
  
  echo "  -> Compilazione & caricamento booking-service..."
  docker build --platform linux/amd64 -q -t "${BOOKING_ECR}:v1.0.0" services/booking-service/
  docker push -q "${BOOKING_ECR}:v1.0.0"
  
  echo "  -> Compilazione & caricamento drop-service..."
  docker build --platform linux/amd64 -q -t "${DROP_ECR}:v1.0.0" services/drop-service/
  docker push -q "${DROP_ECR}:v1.0.0"

  echo "  -> Compilazione & caricamento notification-service..."
  docker build --platform linux/amd64 -q -t "${NOTIF_ECR}:v1.0.0" services/notification-service/
  docker push -q "${NOTIF_ECR}:v1.0.0"
  echo "  Tutte le immagini sono caricate su Amazon ECR."
fi

# --- FASE 4: Configurazione Kubeconfig per Amazon EKS ---
echo ""
echo "=== [4/5] Aggiornamento Kubeconfig per Amazon EKS ==="
echo "  -> Configurazione kubectl per il cluster ${EKS_CLUSTER_NAME} in regione ${AWS_REGION}..."
aws eks update-kubeconfig --name "${EKS_CLUSTER_NAME}" --region "${AWS_REGION}"

# --- FASE 5: Applicazione dei Manifesti Kubernetes su EKS ---
echo ""
echo "=== [5/5] Applicazione dei manifesti Kubernetes dei Microservizi ==="

echo "  -> 0. Verifica disponibilità nodi Worker EKS..."
for i in {1..60}; do
  READY_NODES=$(kubectl get nodes --no-headers 2>/dev/null | grep -c " Ready" || echo "0")
  if [ "$READY_NODES" -ge 2 ]; then
    echo "  -> Nodi EKS rilevati in stato Ready: $READY_NODES"
    break
  fi
  echo "  -> In attesa dei nodi Worker EKS... ($READY_NODES/2 pronti, tentativo $i/60)"
  sleep 10
done

echo "  -> 1. Applicazione Namespace e NetworkPolicies..."
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/network-policy.yaml

echo "  -> 2. Configurazione autenticazione Amazon ECR..."
ECR_PASS=$(aws ecr get-login-password --region "$AWS_REGION" 2>/dev/null || echo "")
REGISTRY=$(echo "$AUTH_ECR" | cut -d'/' -f1)
if [ -n "$ECR_PASS" ] && [ -n "$REGISTRY" ]; then
  kubectl create secret docker-registry ecr-secret -n glamdrop \
    --docker-server="$REGISTRY" \
    --docker-username=AWS \
    --docker-password="$ECR_PASS" \
    --dry-run=client -o yaml | kubectl apply -f -
  
  kubectl patch serviceaccount default -n glamdrop -p '{"imagePullSecrets": [{"name": "ecr-secret"}]}' 2>/dev/null || true
fi
if [ -f k8s/ecr-cronjob.yaml ]; then
  kubectl apply -f k8s/ecr-cronjob.yaml
fi

echo "  -> 3. Applicazione Secrets Generati da Terraform..."
if [ -f k8s/secret.yaml ]; then
  kubectl apply -f k8s/secret.yaml
fi

echo "  -> 4. Installazione Ingress Nginx Controller (NodePort 30080)..."
kubectl apply -f k8s/ingress-nginx.yaml
kubectl delete ValidatingWebhookConfiguration ingress-nginx-admission --ignore-not-found 2>/dev/null || true

echo "  -> 5. Applicazione Microservizi Backend, HPA/PDB e Ingress..."
if [ -n "$AUTH_ECR" ]; then
  sed -i.bak "s|image: auth-service:v1.0.0|image: ${AUTH_ECR}:v1.0.0|g" k8s/auth-service.yaml && rm -f k8s/auth-service.yaml.bak 2>/dev/null || true
  sed -i.bak "s|image: booking-service:v1.0.0|image: ${BOOKING_ECR}:v1.0.0|g" k8s/booking-service.yaml && rm -f k8s/booking-service.yaml.bak 2>/dev/null || true
  sed -i.bak "s|image: drop-service:v1.0.0|image: ${DROP_ECR}:v1.0.0|g" k8s/drop-service.yaml && rm -f k8s/drop-service.yaml.bak 2>/dev/null || true
  sed -i.bak "s|image: notification-service:v1.0.0|image: ${NOTIF_ECR}:v1.0.0|g" k8s/notification-service.yaml && rm -f k8s/notification-service.yaml.bak 2>/dev/null || true
fi

kubectl apply -f k8s/auth-service.yaml
kubectl apply -f k8s/booking-service.yaml
kubectl apply -f k8s/drop-service.yaml
kubectl apply -f k8s/notification-service.yaml
kubectl apply -f k8s/hpa-pdb.yaml || true
kubectl apply -f k8s/ingress.yaml

echo "  -> 6. Rollout restart per ricaricare le nuove configurazioni..."
kubectl rollout restart deployment auth-service booking-service drop-service notification-service -n glamdrop 2>/dev/null || true

echo "  -> 7. Stato dei Pod distribuiti su Amazon EKS:"
kubectl get pods -n glamdrop -o wide
kubectl get pods -n ingress-nginx

echo ""
echo "=========================================================================="
echo " Deployment Amazon EKS completato con successo!"
echo "=========================================================================="
echo "Accedi all'applicazione web tramite:"
echo "   ${CLOUDFRONT_URL}"
echo ""
