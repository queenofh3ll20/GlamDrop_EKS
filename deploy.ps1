# ==========================================================================
#    [GlamDrop-EKS] Deploy su Amazon EKS v1.36 + S3/CloudFront (PowerShell)
# ==========================================================================
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Host "==========================================================================" -ForegroundColor Cyan
Write-Host "   [GlamDrop-EKS] Deploy su Amazon EKS v1.36 + S3/CloudFront" -ForegroundColor Cyan
Write-Host "==========================================================================" -ForegroundColor Cyan

# --- FASE 1: Recupero parametri da Terraform ---
Write-Host "`n=== [1/5] Recupero parametri e credenziali da Terraform ===" -ForegroundColor Yellow
Set-Location (Join-Path $scriptDir "terraform")

$EKS_CLUSTER_NAME = (terraform output -raw eks_cluster_name 2>$null)
$AWS_REGION = (terraform output -raw aws_region 2>$null)
if (-not $AWS_REGION) { $AWS_REGION = "eu-south-1" }
$S3_BUCKET = (terraform output -raw s3_frontend_bucket 2>$null)
$CLOUDFRONT_URL = (terraform output -raw cloudfront_domain_name 2>$null)
$CLOUDFRONT_DIST_ID = (terraform output -raw cloudfront_distribution_id 2>$null)

$AUTH_ECR = (terraform output -raw ecr_auth_service_url 2>$null)
$BOOKING_ECR = (terraform output -raw ecr_booking_service_url 2>$null)
$DROP_ECR = (terraform output -raw ecr_drop_service_url 2>$null)
$NOTIF_ECR = (terraform output -raw ecr_notification_service_url 2>$null)

Set-Location $scriptDir

# Fallback automatico via AWS CLI se necessario
if (-not $EKS_CLUSTER_NAME) {
    $EKS_CLUSTER_NAME = (aws eks list-clusters --region $AWS_REGION --query "clusters[?contains(@, 'glamdrop-eks')][0]" --output text 2>$null)
    if (-not $EKS_CLUSTER_NAME -or $EKS_CLUSTER_NAME -eq "None") {
        $EKS_CLUSTER_NAME = "glamdrop-eks-cluster"
    }
}
if (-not $S3_BUCKET) {
    $S3_BUCKET = (aws s3api list-buckets --query "Buckets[?starts_with(Name, 'glamdrop-eks-frontend')].Name" --output text 2>$null)
}
$AWS_ACCOUNT_ID = (aws sts get-caller-identity --query "Account" --output text 2>$null)
if (-not $AUTH_ECR -and $AWS_ACCOUNT_ID) {
    $AUTH_ECR = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/glamdrop-eks/auth-service"
    $BOOKING_ECR = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/glamdrop-eks/booking-service"
    $DROP_ECR = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/glamdrop-eks/drop-service"
    $NOTIF_ECR = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/glamdrop-eks/notification-service"
}
if (-not $CLOUDFRONT_URL -or -not $CLOUDFRONT_DIST_ID) {
    $CLOUDFRONT_DIST_ID = (aws cloudfront list-distributions --query "DistributionList.Items[?contains(Comment, 'glamdrop-eks')].Id | [0]" --output text 2>$null)
    if ($CLOUDFRONT_DIST_ID -and $CLOUDFRONT_DIST_ID -ne "None") {
        $domain = (aws cloudfront get-distribution --id $CLOUDFRONT_DIST_ID --query "Distribution.DomainName" --output text 2>$null)
        $CLOUDFRONT_URL = "https://$domain"
    }
}

if (-not $EKS_CLUSTER_NAME) {
    Write-Error "Impossibile determinare il cluster EKS. Verifica i Terraform output."
    exit 1
}

Write-Host "  -> EKS Cluster Name: $EKS_CLUSTER_NAME"
Write-Host "  -> AWS Region: $AWS_REGION"
Write-Host "  -> S3 Frontend Bucket: $S3_BUCKET"
Write-Host "  -> CloudFront URL: $CLOUDFRONT_URL"
Write-Host "  -> CloudFront Dist ID: $CLOUDFRONT_DIST_ID"
Write-Host "  -> ECR Auth Service: $AUTH_ECR"

# --- FASE 2: Deploy Frontend su AWS S3 & CloudFront ---
Write-Host "`n=== [2/5] Deploy del Frontend su S3 e invalidazione CDN ===" -ForegroundColor Yellow
if ($S3_BUCKET -and $S3_BUCKET -ne "None") {
    Write-Host "  -> Sincronizzazione file statici su s3://$S3_BUCKET..."
    aws s3 sync frontend/ "s3://$S3_BUCKET/" --exclude "Dockerfile" --exclude "nginx.conf" --delete
    Write-Host "  [OK] Frontend caricato con successo su S3." -ForegroundColor Green

    if ($CLOUDFRONT_DIST_ID -and $CLOUDFRONT_DIST_ID -ne "None") {
        Write-Host "  -> Invalidazione cache CloudFront ($CLOUDFRONT_DIST_ID)..."
        aws cloudfront create-invalidation --distribution-id $CLOUDFRONT_DIST_ID --paths "/*" | Out-Null
        Write-Host "  [OK] Invalidazione cache CloudFront richiesta." -ForegroundColor Green
    }
}

# --- FASE 3: Build & Push Immagini Docker su ECR ---
$hasDocker = Get-Command docker -ErrorAction SilentlyContinue
if ($hasDocker -and $AUTH_ECR) {
    Write-Host "`n=== [3/5] Build & Push immagini Docker su Amazon ECR ===" -ForegroundColor Yellow
    $REGISTRY = $AUTH_ECR.Split("/")[0]
    Write-Host "  -> Autenticazione con Amazon ECR ($REGISTRY)..."
    aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REGISTRY | Out-Null

    Write-Host "  -> Compilazione & caricamento auth-service..."
    docker build --platform linux/amd64 -q -t "${AUTH_ECR}:v1.0.0" services/auth-service/
    docker push -q "${AUTH_ECR}:v1.0.0"

    Write-Host "  -> Compilazione & caricamento booking-service..."
    docker build --platform linux/amd64 -q -t "${BOOKING_ECR}:v1.0.0" services/booking-service/
    docker push -q "${BOOKING_ECR}:v1.0.0"

    Write-Host "  -> Compilazione & caricamento drop-service..."
    docker build --platform linux/amd64 -q -t "${DROP_ECR}:v1.0.0" services/drop-service/
    docker push -q "${DROP_ECR}:v1.0.0"

    Write-Host "  -> Compilazione & caricamento notification-service..."
    docker build --platform linux/amd64 -q -t "${NOTIF_ECR}:v1.0.0" services/notification-service/
    docker push -q "${NOTIF_ECR}:v1.0.0"
    Write-Host "  [OK] Tutte le immagini sono caricate su Amazon ECR." -ForegroundColor Green
}

# --- FASE 4: Configurazione Kubeconfig per Amazon EKS ---
Write-Host "`n=== [4/5] Aggiornamento Kubeconfig per Amazon EKS ===" -ForegroundColor Yellow
Write-Host "  -> Configurazione kubectl per il cluster $EKS_CLUSTER_NAME in regione $AWS_REGION..."
aws eks update-kubeconfig --name $EKS_CLUSTER_NAME --region $AWS_REGION

# --- FASE 5: Applicazione dei Manifesti Kubernetes su EKS ---
Write-Host "`n=== [5/5] Applicazione dei manifesti Kubernetes dei Microservizi ===" -ForegroundColor Yellow

Write-Host "  -> 0. Verifica disponibilità nodi Worker EKS..."
for ($i = 1; $i -le 60; $i++) {
    $readyNodes = (kubectl get nodes --no-headers 2>$null | Select-String -Pattern " Ready" | Measure-Object).Count
    if ($readyNodes -ge 2) {
        Write-Host "  -> Nodi EKS rilevati in stato Ready: $readyNodes"
        break
    }
    Write-Host "  -> In attesa dei nodi Worker EKS... ($readyNodes/2 pronti, tentativo $i/60)"
    Start-Sleep -Seconds 10
}

Write-Host "  -> 1. Applicazione Namespace e NetworkPolicies..."
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/network-policy.yaml

Write-Host "  -> 2. Configurazione autenticazione Amazon ECR..."
$ECR_PASS = (aws ecr get-login-password --region $AWS_REGION 2>$null)
$REGISTRY = $AUTH_ECR.Split("/")[0]
if ($ECR_PASS -and $REGISTRY) {
    kubectl create secret docker-registry ecr-secret -n glamdrop --docker-server=$REGISTRY --docker-username=AWS --docker-password=$ECR_PASS --dry-run=client -o yaml | kubectl apply -f -
    kubectl patch serviceaccount default -n glamdrop -p '{"imagePullSecrets": [{"name": "ecr-secret"}]}' 2>$null | Out-Null
}
if (Test-Path "k8s/ecr-cronjob.yaml") {
    kubectl apply -f k8s/ecr-cronjob.yaml
}

Write-Host "  -> 3. Applicazione Secrets Generati da Terraform..."
if (Test-Path "k8s/secret.yaml") {
    kubectl apply -f k8s/secret.yaml
}

Write-Host "  -> 4. Installazione Ingress Nginx Controller (NodePort 30080)..."
kubectl apply -f k8s/ingress-nginx.yaml
kubectl delete ValidatingWebhookConfiguration ingress-nginx-admission --ignore-not-found 2>$null | Out-Null

Write-Host "  -> 5. Applicazione Microservizi Backend, HPA/PDB e Ingress..."
if ($AUTH_ECR) {
    (Get-Content k8s/auth-service.yaml) -replace "image: auth-service:v1.0.0", "image: ${AUTH_ECR}:v1.0.0" | Set-Content k8s/auth-service.yaml
    (Get-Content k8s/booking-service.yaml) -replace "image: booking-service:v1.0.0", "image: ${BOOKING_ECR}:v1.0.0" | Set-Content k8s/booking-service.yaml
    (Get-Content k8s/drop-service.yaml) -replace "image: drop-service:v1.0.0", "image: ${DROP_ECR}:v1.0.0" | Set-Content k8s/drop-service.yaml
    (Get-Content k8s/notification-service.yaml) -replace "image: notification-service:v1.0.0", "image: ${NOTIF_ECR}:v1.0.0" | Set-Content k8s/notification-service.yaml
}

kubectl apply -f k8s/auth-service.yaml
kubectl apply -f k8s/booking-service.yaml
kubectl apply -f k8s/drop-service.yaml
kubectl apply -f k8s/notification-service.yaml
kubectl apply -f k8s/hpa-pdb.yaml 2>$null | Out-Null
kubectl apply -f k8s/ingress.yaml

Write-Host "  -> 6. Rollout restart per ricaricare le nuove configurazioni..."
kubectl rollout restart deployment auth-service booking-service drop-service notification-service -n glamdrop 2>$null | Out-Null

Write-Host "`n  -> 7. Stato dei Pod distribuiti su Amazon EKS:"
kubectl get pods -n glamdrop -o wide
kubectl get pods -n ingress-nginx

Write-Host "`n==========================================================================" -ForegroundColor Green
Write-Host " Deployment Amazon EKS completato con successo!" -ForegroundColor Green
Write-Host "==========================================================================" -ForegroundColor Green
Write-Host "Accedi all'applicazione web tramite:" -ForegroundColor Cyan
Write-Host "   $CLOUDFRONT_URL" -ForegroundColor Yellow
Write-Host ""
