<div align="center">

<img src="docs/assets/logo.png" alt="GlamDrop Logo" width="160"/>

<h1 align="center">GlamDrop EKS — Beauty Booking Platform su Amazon EKS v1.36</h1>

<p align="center">
  Versione enterprise cloud-native della piattaforma <strong>GlamDrop</strong> su <strong>Amazon Elastic Kubernetes Service (EKS)</strong>.<br>
  Control Plane gestito ad alta affidabilità Multi-AZ (SLA 99.95%), <strong>EKS Managed Node Groups</strong>,<br>
  networking nativo ad alte prestazioni con <strong>AWS VPC CNI</strong> e segregazione dei privilegi con <strong>IAM Roles for Service Accounts (IRSA)</strong>.<br>
  Mitigazione atomica del <strong>Thundering Herd Problem</strong> tramite script Lua in-memory su ElastiCache Redis.
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
![Status](https://img.shields.io/badge/status-active-success.svg?style=for-the-badge)
![Kubernetes](https://img.shields.io/badge/kubernetes-1.36-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)
![Amazon EKS](https://img.shields.io/badge/Amazon%20EKS-Managed%20Cluster-FF9900?style=for-the-badge&logo=amazon-aws&logoColor=white)
![AWS VPC CNI](https://img.shields.io/badge/AWS%20VPC%20CNI-Native%20IPs-232F3E?style=for-the-badge)
![IRSA](https://img.shields.io/badge/IAM%20OIDC-IRSA%20Security-success?style=for-the-badge)
![Terraform](https://img.shields.io/badge/Terraform-IaC-7B42BC?style=for-the-badge&logo=terraform&logoColor=white)

</div>

---

## 🎯 Panoramica

**GlamDrop EKS** (Infrastruttura B) rappresenta la variante enterprise di GlamDrop, interamente reingegnerizzata su **Amazon EKS v1.36** per eliminare l'onere di manutenzione del Control Plane ed offrire scalabilità orizzontale dinamica, alta affidabilità e sicurezza nativa AWS.

La piattaforma mette in relazione tre tipologie di utenti:

<div align="center">

| 👤 Ruolo | Descrizione |
|:---:|---|
| ![Cliente](https://img.shields.io/badge/Cliente-8A2BE2?style=flat-square) | Ricerca saloni con autocompletamento geografico, prenota trattamenti e riscatta i Drop promozionali |
| ![Gestore](https://img.shields.io/badge/Gestore-FF69B4?style=flat-square) | Amministra il catalogo servizi, configura orari/turni del personale e monitora le prenotazioni |
| ![Estetista](https://img.shields.io/badge/Estetista-20B2AA?style=flat-square) | Consulta l'agenda appuntamenti in tempo reale e segnala indisponibilità o assenze |

</div>

### ⚡ Il Concetto di "Drop" e la Gestione della Concorrenza
Il fulcro del sistema sono i **Drop**: promozioni flash a disponibilità limitata generate automaticamente con il **50% di sconto** a seguito di cancellazioni tardive (< 24h dall'appuntamento). 
Per scongiurare il **Thundering Herd Problem** e l'overselling durante i picchi simultanei di claim, la concorrenza è gestita mediante **script atomici Lua** eseguiti nel single-thread di **Amazon ElastiCache Redis 7**, rispondendo con HTTP `202 Accepted` all'unico vincitore e HTTP `409 Conflict` agli altri utenti in < 2ms, delegando il salvataggio a worker asincroni su **Amazon MQ RabbitMQ**.

![divider](https://capsule-render.vercel.app/api?type=soft&color=0:FF69B4,100:FFA500&height=3&section=header)

### ✨ Funzionalità principali

| Area | Funzionalità |
|---|---|
| 🔐 **Autenticazione & Saloni** | Registrazione multi-ruolo (Cliente, Gestore, Dipendente), login con token JWT firmati, gestione anagrafica e dataset ISTAT dei comuni italiani |
| 📅 **Prenotazioni & Disponibilità** | Catalogo trattamenti con 7 categorie, calcolo slot a intervalli di 15m, lock pessimistici sul DB relazionale e rilevamento anti-sovrapposizione |
| ⚡ **Flash Drop & Lock Atomico** | Generazione automatica da disdette tardive, lock atomico in-memory Redis (`HGET` + `HSET`), ingestione asincrona su coda RabbitMQ |
| 🔔 **Notifiche & Sicurezza IRSA** | Consumer AMQP su RabbitMQ, persistenza NoSQL su **Amazon DynamoDB** protetta da ruolo IAM associato al singolo ServiceAccount Pod via OIDC (IRSA) |
| 📈 **Autoscaling Dinamico & Resilienza** | Horizontal Pod Autoscaler (**HPA v2**) con scalabilità automatica (2–5 pod su soglia CPU), affiancato da **PodDisruptionBudget (PDB)** per zero-downtime |
| 🌐 **Edge Delivery & CDN** | Frontend statico distribuito su **Amazon S3 + CloudFront CDN** con OAC, routing Layer 7 via ALB e verifica header `X-Origin-Verify` |

---

## 🏗 Architettura & Flusso degli Eventi

<div align="center">

<img src="docs/assets/Architettura.png" alt="Architettura del sistema GlamDrop" width="90%"/>

![divider](https://capsule-render.vercel.app/api?type=soft&color=0:FF69B4,100:FFA500&height=3&section=header)

<img src="docs/assets/Applicazione.png" alt="Interfaccia dell'applicazione GlamDrop" width="90%"/>

![divider](https://capsule-render.vercel.app/api?type=soft&color=0:FF69B4,100:FFA500&height=3&section=header)

</div>

### 📸 Schema Architetturale Amazon EKS

```
[ Utente / Browser ]
        │
        ▼
[ Amazon CloudFront CDN ] (PriceClass_100, OAC, Security Headers, SPA Fallback)
   ├── /*         ──► [ Amazon S3 Bucket ] (Frontend SPA: HTML5/CSS3/Vanilla JS)
   └── /api/*     ──► [ AWS Application Load Balancer (ALB) ]
                            │ (Port 80 -> NodePort 30080, X-Origin-Verify)
                            ▼
      [ Amazon EKS Cluster (Control Plane Gestito v1.36 Multi-AZ) ]
                            │
            ┌───────────────┴─────────────────────────┐
            │  EKS Managed Node Group (Worker Nodes)  │
            │  • Ingress Nginx Controller (NodePort)  │
            │  • Auth Service (Node.js/Express, HPA)  │
            │  • Booking Service (Node.js, HPA)       │
            │  • Drop Service (Node.js/Express, HPA)  │
            │  • Notification Service (Python/Flask)  │
            │  • AWS VPC CNI (IP Reali della VPC)     │
            │  • CoreDNS, Kube-Proxy & IRSA OIDC      │
            └─────────────────────────────────────────┘
                    │             │            │            │
                    ▼             ▼            ▼            ▼
             [ Amazon RDS ]  [ Amazon MQ ] [ ElastiCache ] [ DynamoDB ]
             (PostgreSQL 15)  (RabbitMQ)     (Redis 7)     (via IRSA)
             (Encrypted gp3)  (AMQPS TLS)   (In-Transit)   (Pay-Per-Request)
```

### 🔄 Flusso degli eventi
1. Un **cliente cancella** una prenotazione con anticipo < 24h $\rightarrow$ il *Booking Service* pubblica `booking.cancelled.late` su **Amazon MQ (RabbitMQ)**.
2. Il **Drop Service** consuma l'evento: genera il record promozionale su **RDS PostgreSQL** e carica il payload su **ElastiCache Redis** con TTL dinamico.
3. Più clienti tentano simultaneamente il claim $\rightarrow$ lo script Lua in **Redis** esegue il lock atomico: il primo riceve `202 Accepted`, mentre tutti gli altri ricevono istantaneamente `409 Conflict`.
4. Il claim vincitore viene inviato sulla coda `drop.claims.processing` per la finalizzazione asincrona su RDS e l'aggiornamento dell'agenda su Booking Service.
5. Il **Notification Service** consuma gli eventi e persiste l'audit trail su **Amazon DynamoDB**, autenticandosi in modo sicuro con le credenziali temporanee fornite da **IRSA**.

---

## 🏷️ Convenzione dei Tag & Isolamento su AWS

Per consentire la coesistenza trasparente e la distinzione sulla console AWS rispetto all'infrastruttura basata su EC2 (`glamdrop`), tutte le risorse di questo ambiente sono contrassegnate tramite:

- **Project Prefix**: `glamdrop-eks` (es. `glamdrop-eks-cluster`, `glamdrop-eks-vpc`, `glamdrop-eks-postgres-db`, `glamdrop-eks-rabbitmq`)
- **Default Tags**:
  - `Project = "glamdrop-eks"`
  - `Platform = "EKS"`
  - `Environment = "test"` (o `prod`/`dev`)
  - `ManagedBy = "Terraform"`
- **Subnet Discovery Tags**:
  - `kubernetes.io/cluster/glamdrop-eks-cluster = "shared"`
  - `kubernetes.io/role/elb = "1"` (Subnet pubbliche)
  - `kubernetes.io/role/internal-elb = "1"` (Subnet private)

---

## 🛠 Stack Tecnologico & Mappatura Servizi AWS Gestiti

<div align="center">

<img src="https://skillicons.dev/icons?i=nodejs,express,python,flask,postgres,redis,html,css,js,nginx,docker,kubernetes,terraform,aws" alt="Tech stack icons"/>

</div>

| Modulo / Servizio | Tecnologia | Servizio AWS / Hosting | Responsabilità & Dettagli |
| :--- | :--- | :--- | :--- |
| **Kubernetes Control Plane** | Kubernetes **v1.36** | **Amazon EKS** | Control Plane gestito da AWS con SLA 99.95%, alta disponibilità Multi-AZ, patch automatiche e Access Entries IAM. |
| **Worker Nodes** | AL2023 Optimized | **EKS Managed Node Group** | Scaling group di nodi worker gestiti con rolling updates automatizzati e registrazione al target group dell'ALB. |
| **Pod Networking** | AWS VPC CNI | **VPC CNI Plugin** | Assegnazione di IP secondari reali della VPC a ciascun Pod (zero overhead overlay, piena tracciabilità VPC Flow Logs). |
| **Frontend SPA** | HTML5, CSS3, JS ES6+ | **Amazon S3 + CloudFront CDN** | Hosting statico privato su S3 protetto da Origin Access Control (OAC), fallback SPA `/index.html` e Security Headers. |
| **Reverse Proxy / Ingress** | AWS ALB + Ingress Nginx | **Application Load Balancer** | Instradamento centralizzato da CloudFront con verifica secret header `X-Origin-Verify` verso la NodePort `30080`. |
| **Auth Service** | Node.js 20, Express, pg, jwt | **EKS + Amazon RDS** | Autenticazione JWT, gestione saloni e clienti; persistenza su **PostgreSQL 15 (RDS)** con crittografia KMS at-rest e SSL forzato. |
| **Booking Service** | Node.js 20, Express, pg, amqp | **EKS + RDS & Amazon MQ** | Gestione prenotazioni e turni; pubblicazione asincrona di eventi su **Amazon MQ RabbitMQ (AMQPS TLS)**. |
| **Drop Service** | Node.js 20, Express, Redis, amqp | **EKS + RDS, Redis & MQ** | Flash sales su cancellazioni tardive con claiming ad alta velocità su **ElastiCache Redis 7** e salvataggio su RDS. |
| **Notification Service** | Python 3.11, Flask, boto3 | **EKS + Amazon MQ & DynamoDB** | Consumer AMQP per notifiche; persistenza NoSQL su **DynamoDB** con privilegi IAM segregati tramite **OIDC IRSA**. |
| **Message Broker** | RabbitMQ 3.13 (AMQPS) | **Amazon MQ for RabbitMQ** | Broker gestito per il disaccoppiamento affidabile degli eventi applicativi (canale TLS porta 5671). |
| **In-Memory Cache** | Redis 7 | **Amazon ElastiCache Redis** | Cluster gestito con crittografia at-rest KMS, transit encryption TLSv1.2 e Redis AUTH token. |
| **Secrets & Config** | SSM Parameter Store | **AWS Systems Manager** | Archiviazione centralizzata dei secret (`SecureString`) e generazione automatica di `k8s/secret.yaml`. |
| **Container Registry** | Docker Multi-Stage | **Amazon ECR** | Repository per container con scansione automatica vulnerabilità e lifecycle policies. |
| **Monitoring & Alarms** | CloudWatch Metrics | **Amazon CloudWatch** | Monitoraggio proattivo su CPU nodi EKS, metriche RDS e allarmi codici 5XX sull'ALB. |

---

## ⚙️ Infrastruttura EKS

### 🖥️ Specifiche del Cluster

| Componente | Tipo / Risorsa | Configurazione | Note di Esercizio |
|:---|:---:|:---:|:---|
| **EKS Control Plane** | Amazon EKS v1.36 | Multi-AZ (3 AZ) | Gestito da AWS (SLA 99.95%), audit log CloudWatch, Access Entries IAM |
| **EKS Node Group** | `t3.small` (x2) | Multi-AZ (AZ-a & AZ-b) | Managed Node Group con Amazon Linux 2023, rolling updates automatici |
| **Pod Networking (CNI)** | AWS VPC CNI Plugin | IP Reali della VPC | Assegnazione diretta di IP secondari ENI a ciascun Pod |
| **Ingress Tier** | ALB + Nginx Ingress | NodePort `30080` | Ricezione traffico instradato da CloudFront CDN |

### 📦 Pipeline IaC & Deployment

```
┌─────────────────────────────────┐
│     1. TERRAFORM APPLY          │ ──► Crea Cluster EKS v1.36, Node Group, VPC, RDS, Redis, MQ, ALB
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     2. UPDATE KUBECONFIG        │ ──► aws eks update-kubeconfig --name glamdrop-eks-cluster
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     3. ./deploy.sh (o .ps1)     │ ──► Build ECR, Deploy K8s (HPA, PDB, IRSA), Sync S3/CloudFront
└─────────────────────────────────┘
```

---

## 🚀 Guida al Deployment su Amazon EKS (Step-by-Step)

Il deployment dell'infrastruttura e dei microservizi su Amazon EKS si esegue in **2 passaggi automatizzati** (Ansible non è necessario):

### ✅ Prerequisiti
- **AWS CLI (v2)** installata e configurata (`aws configure`).
- **Terraform** (>= 1.5.0).
- **kubectl** installato localmente per interagire con il cluster EKS.
- **Docker** (opzionale, per compilazione e push delle immagini su Amazon ECR).

---

### 1️⃣ Passo 1: Provisioning del Cluster EKS con Terraform

1. Spostati nella cartella `terraform/`:
   ```bash
   cd terraform
   terraform init
   ```
2. Esegui il deployment delle risorse su AWS:
   ```bash
   terraform apply -auto-approve
   ```
   *Terraform istanzierà il cluster EKS v1.36 gestito, i Managed Node Groups, la VPC Multi-AZ con i tag di discovery, l'ALB con Target Group NodePort 30080, RDS PostgreSQL, Amazon MQ RabbitMQ, DynamoDB, ElastiCache Redis, S3, CloudFront OAC e genererà automaticamente `k8s/secret.yaml`.*

---

### 2️⃣ Passo 2: Allineamento del Kubeconfig Locale

Configura `kubectl` per interagire con il nuovo cluster EKS:

```bash
aws eks update-kubeconfig --region eu-south-1 --name glamdrop-eks-cluster
kubectl get nodes
```
Tutti i nodi del Managed Node Group risulteranno in stato **`Ready`**.

---

### 3️⃣ Passo 3: Deployment dei Microservizi e Frontend (`deploy.sh`)

Dalla radice del repository, esegui lo script di automazione (Bash su Linux/WSL/Git Bash o PowerShell su Windows):

```bash
# Su Linux / WSL / Git Bash:
chmod +x deploy.sh
./deploy.sh

# Oppure su Windows PowerShell:
.\deploy.ps1
```

#### Operazioni eseguite automaticamente dallo script:
1. **Recupero Parametri**: Estrae gli output da Terraform (Nome cluster EKS, S3, CloudFront, ECR).
2. **Deploy Frontend**: Sincronizza i file statici su S3 e richiede l'invalidazione della cache CloudFront.
3. **Build & Push ECR**: Compila e carica le immagini dei microservizi su Amazon ECR.
4. **Allineamento Contesto**: Verifica l'aggiornamento del contesto locale `kubectl`.
5. **Rollout Microservizi**: Applica Namespace, Secret, NetworkPolicies, Ingress Nginx, Deployments, Servizi, regole di autoscaling (**HPA v2**), **PodDisruptionBudget (PDB)** e Ingress.

Al termine, l'applicazione sarà accessibile all'URL di CloudFront:
```
👉 https://dxxxxxxxxxxxx.cloudfront.net
```

---

## 🔧 Configurazione Variabili d'Ambiente e Secret Kubernetes

### 1️⃣ Secret Kubernetes (`k8s/secret.yaml`)
I secret applicativi sono **generati automaticamente da Terraform** durante il provisioning, iniettando le credenziali casuali e gli endpoint effettivi dei servizi gestiti.

### 2️⃣ Segregazione IAM tramite IRSA (IAM Roles for Service Accounts)
A differenza dei cluster tradizionali su VM, il microservizio `notification-service` non riceve credenziali statiche ma assume un ruolo IAM temporaneo tramite il proprio ServiceAccount Kubernetes:
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: notification-service-sa
  namespace: glamdrop
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::<ACCOUNT_ID>:role/glamdrop-eks-notification-dynamodb-role
```

---

## 🧪 Test Automatizzati

### 🐑 Test Concorrenza Drop — "Thundering Herd"
Simula **50 clienti concorrenti** che tentano simultaneamente di riscattare l'ultimo Drop:
```bash
python tests/test-concurrency.py --endpoint https://<CLOUDFRONT_DOMAIN>/api
```
- ✅ **Esito atteso**: esattamente **1 client** riceve HTTP `202 Accepted` (claim confermato), mentre i restanti **49** ricevono HTTP `409 Conflict`.
- 🔒 **Integrità**: quantità residua pari a `0`, nessun overselling o blocco su RDS.

### 📆 Test Sovrapposizione Prenotazioni
Verifica la prevenzione dei conflitti di orario:
```bash
python tests/test-booking-overlap.py --endpoint https://<CLOUDFRONT_DOMAIN>/api
```

| # | Scenario di Test | Esito Atteso |
|:---:|---|:---:|
| 1 | Prenotazione slot base (10:00–11:00) | ✅ Confermata (201) |
| 2 | Stesso identico orario sullo stesso operatore | ❌ Conflitto (409) |
| 3 | Sovrapposizione parziale inizio (10:30–11:30) | ❌ Conflitto (409) |
| 4 | Sovrapposizione parziale fine (09:30–10:30) | ❌ Conflitto (409) |
| 5 | Intervallo interamente contenuto (10:15–10:45) | ❌ Conflitto (409) |
| 6 | Slot adiacente senza sovrapposizione (11:00–12:00) | ✅ Confermata (201) |
| 7 | Cancellazione e ri-prenotazione dello stesso slot | ✅ Confermata (201) |

---

## 🛡️ Sicurezza Avanzata, Resilienza & DevSecOps su EKS

- **IAM Roles for Service Accounts (IRSA)**:
  - Federazione OIDC tra il cluster EKS e AWS IAM: solo i pod del `notification-service` possono accedere alla tabella DynamoDB, azzerando i rischi di privilege escalation.
- **EKS Access Entries**:
  - Gestione granulare dell'accesso al cluster integrata nativamente con IAM, superando la complessità della ConfigMap `aws-auth`.
- **Autoscaling Dinamico & Continuità Operativa**:
  - **HPA v2**: scala automaticamente le repliche dei microservizi da 2 a 5 in base all'utilizzo della CPU.
  - **PodDisruptionBudget (PDB)**: garantisce che almeno una replica di ciascun servizio rimanga sempre attiva durante rolling updates o drain dei nodi.
- **Networking Nativo AWS VPC CNI**:
  - I Pod utilizzano IP reali della VPC, azzerando l'overhead di incapsulamento e garantendo visibilità completa nei **VPC Flow Logs**.
- **Crittografia Completa & Protezione Perimetrale**:
  - Crittografia at-rest KMS su RDS, ElastiCache ed EBS.
  - Crittografia in-transit TLSv1.2, AMQPS (5671) e SSL forzato su RDS.
  - Validazione header segreto `X-Origin-Verify` tra CloudFront e l'ALB.

---

## 🧹 Teardown dell'Infrastruttura

Per distruggere determinatisticamente tutte le risorse create su AWS ed azzerare i costi:

```bash
cd terraform
terraform destroy -auto-approve
```

---

<div align="center">

![Footer wave](https://capsule-render.vercel.app/api?type=waving&color=0:FF69B4,100:FFA500&height=150&section=footer&text=GlamDrop%20EKS%20Infrastructure%20B&fontSize=26&fontColor=ffffff&animation=fadeIn)

</div>