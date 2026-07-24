# Deploy en GCP — Cloud Run + Load Balancer + CI/CD

Deploy de Open Carrusel en **Cloud Run** (una instancia fija) detrás de un
**HTTPS Load Balancer** de Google (el "nginx administrado": TLS gestionado, IP
estática, DNS limpio). El deploy es automático: cada push a `main` construye y
publica vía **GitHub Actions**.

```
Diseñadora ──HTTPS──▶ Load Balancer (IP estática, cert Google)
                          │  serverless NEG
                          ▼
                   Cloud Run  (min=max=1, gen2, CPU always-on)
                     │  HOSTED_MODE=1 · spawn claude con token de la usuaria
                     ├─ volumen GCS  → /app/data        (DB JSON, usuarias, tokens)
                     ├─ volumen GCS  → /app/public/uploads (imágenes subidas)
                     └─ avatares horneados read-only en la imagen
```

## ⚠ Restricción que no se toca: UNA sola instancia

La "base de datos" son archivos JSON en `/app/data` con lock **por proceso**.
`min-instances=1 max-instances=1` es **obligatorio**, no un parámetro de
performance: con 2+ instancias, dos procesos escriben el mismo archivo sin
coordinarse y **corrompen los datos**. Escalar horizontalmente requiere primero
migrar a una base de datos real. Está fijado en `deploy/cloudrun-deploy.sh`.

## Qué persiste dónde

| Estado | Dónde | Sobrevive redeploy |
|---|---|---|
| Usuarias, tokens, carruseles, presets | bucket GCS → `/app/data` | ✅ |
| Imágenes subidas (referencias) | bucket GCS → `/app/public/uploads` | ✅ |
| Avatares (assets de marca) | horneados en la imagen (read-only) | ✅ (via nuevo build) |
| Sesiones de chat `--resume` | `/tmp` local (efímero) | ❌ (a propósito: son cortas) |

Los avatares se manejan por git (dropear en `30x/avatars/<slug>/assets/` y
pushear); el siguiente deploy los incluye. Subir avatares en runtime **no**
persiste en Cloud Run — para eso haría falta un tercer bucket.

## Paso a paso (primera vez)

Necesitás: `gcloud` autenticado con permisos de Owner/Editor en el proyecto, y
Node instalado (para generar secretos).

### 1. Configurar

```bash
cp deploy/gcp.env.example deploy/gcp.env
# Completar: PROJECT_ID, APP_DOMAIN, GITHUB_REPO (el resto tiene defaults)
```

### 2. Infra base

```bash
bash deploy/gcp-setup.sh
```

Crea Artifact Registry, buckets, secretos (los genera solo), la service account
de runtime y el Workload Identity para CI. **Al final imprime los valores para
GitHub** — copialos.

### 3. Cargar Variables y Secrets en GitHub

En el repo → **Settings → Secrets and variables → Actions**, pegá lo que
imprimió el script:

- **Variables**: `GCP_PROJECT_ID`, `GCP_REGION`, `CLOUD_RUN_SERVICE`, `AR_REPO`,
  `APP_DOMAIN`, `BUCKET_DATA`, `BUCKET_UPLOADS`, `RUNTIME_SA_EMAIL`
- **Secrets**: `WIF_PROVIDER`, `CI_SERVICE_ACCOUNT`

### 4. Primer deploy

Push a `main` (o corré el workflow a mano desde la pestaña Actions). GitHub
Actions construye, publica y deploya. El servicio queda arriba pero todavía solo
accesible por el Load Balancer (paso 5).

> ¿Deploy manual sin CI? Con `deploy/gcp.env` completo:
> ```bash
> IMAGE=$(gcloud builds submit --tag "$REGION-docker.pkg.dev/$PROJECT_ID/$AR_REPO/app:manual" --format='value(...)' ) # o construí y anotá el tag
> IMAGE=... RUNTIME_SA_EMAIL=... bash deploy/cloudrun-deploy.sh
> ```

### 5. Load Balancer + DNS

```bash
bash deploy/gcp-loadbalancer.sh
```

Crea la IP estática, el NEG, el backend, el certificado gestionado y las reglas
443/80. **Imprime la IP** — creá el record DNS donde administrás el dominio:

```
Tipo A · Nombre <tu dominio> · Valor <IP que imprimió> · TTL 300
```

Cuando el DNS propague, Google emite el certificado solo (15-60 min). Estado:

```bash
gcloud compute ssl-certificates describe oc-cert --global --format='value(managed.status)'
# PROVISIONING → ACTIVE
```

### 6. Crear las usuarias

```bash
gcloud run services proxy "$SERVICE" --region="$REGION" &   # túnel local temporal
# o entrá al contenedor por Cloud Shell. Las altas se hacen con el CLI:
#   node scripts/users.mjs add <usuaria> --nombre "Nombre"
```

> Nota: `users.mjs` escribe en `/app/data` (el bucket). En Cloud Run conviene
> correrlo **dentro** de una instancia. La forma más simple: una Cloud Run Job
> one-off con la misma imagen y el mismo volumen, o `gcloud run services
> update` con un contenedor efímero. Ver "Altas de usuarias" abajo.

Pasales a las diseñadoras la URL, su contraseña temporal y la
[guía de conexión](GUIA-CONECTAR-CLAUDE.md).

## De ahí en más

Pushear a `main` = deploy automático. No hay que tocar nada más.

## Altas de usuarias en Cloud Run

Como `/app/data` vive en el bucket, cualquier proceso con ese volumen montado
puede gestionar usuarias. Lo más limpio es una **Cloud Run Job** con la misma
imagen:

```bash
gcloud run jobs create oc-users \
  --project="$PROJECT_ID" --region="$REGION" \
  --image="$(gcloud run services describe $SERVICE --region=$REGION --format='value(spec.template.spec.containers[0].image)')" \
  --service-account="$RUNTIME_SA_EMAIL" \
  --execution-environment=gen2 \
  --add-volume=name=data,type=cloud-storage,bucket="$BUCKET_DATA" \
  --add-volume-mount=volume=data,mount-path=/app/data \
  --command=node --args=scripts/users.mjs,add,valentina,--nombre,Valentina

gcloud run jobs execute oc-users --region="$REGION"
# la contraseña temporal sale en los logs de la ejecución
```

(Cambiá `--args` para `list` / `reset` / `remove`.)

## Costos aproximados

- Cloud Run 1 instancia siempre activa (2 vCPU, 4 GB, CPU always-on): ~$45-60/mo
- Load Balancer: ~$18/mo + tráfico
- GCS (unos MB): centavos
- Cloud Build: primeros 120 min/día gratis

## Troubleshooting

- **Cert en PROVISIONING para siempre**: el DNS no resuelve a la IP del LB.
  Verificá el record A y esperá propagación.
- **502 en el LB**: el servicio no arrancó. Mirá logs:
  `gcloud run services logs read $SERVICE --region=$REGION`.
- **Datos que "desaparecen"**: revisá que `min/max instances` sigan en 1 y que
  los volúmenes GCS estén montados (`gcloud run services describe`).
- **Generación falla con auth**: la usuaria no conectó su token, o venció. Va a
  su `/cuenta` y pega uno nuevo.
