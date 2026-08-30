import os
import sys
import time
import json
import uuid
import threading
from collections import deque
from datetime import datetime, timezone
from decimal import Decimal
import pika
from flask import Flask, jsonify, request
from flask_cors import CORS

RABBITMQ_URL = os.environ.get('RABBITMQ_URL')
if not RABBITMQ_URL:
    print("FATAL: Environment variable RABBITMQ_URL is required but not set.", file=sys.stderr)
    sys.exit(1)

DYNAMODB_TABLE = os.environ.get('DYNAMODB_TABLE', 'glamdrop-notifications')
AWS_REGION = os.environ.get('AWS_REGION', 'eu-south-1')

app_flask = Flask(__name__)
CORS(app_flask)

def sanitize_dynamodb_data(obj):
    """Converte ricorsivamente i tipi Decimal di DynamoDB e deserializza i payload JSON per jsonify"""
    if isinstance(obj, list):
        return [sanitize_dynamodb_data(i) for i in obj]
    elif isinstance(obj, dict):
        res = {}
        for k, v in obj.items():
            if k == 'data' and isinstance(v, str):
                try:
                    res[k] = json.loads(v)
                except Exception:
                    res[k] = v
            else:
                res[k] = sanitize_dynamodb_data(v)
        if 'notification_id' in res and 'id' not in res:
            res['id'] = res['notification_id']
        return res
    elif isinstance(obj, Decimal):
        return int(obj) if obj % 1 == 0 else float(obj)
    return obj

# DynamoDB client setup (HTTPS TLS 1.2+ automatico in-transit)
dynamodb_table = None
try:
    import boto3
    dynamodb = boto3.resource('dynamodb', region_name=AWS_REGION)
    dynamodb_table = dynamodb.Table(DYNAMODB_TABLE)
    print(f"DynamoDB inizializzato per tabella: {DYNAMODB_TABLE} (regione: {AWS_REGION})")
except Exception as e:
    print(f"[WARN] Inizializzazione DynamoDB fallita ({e}). Verrà utilizzato fallback in-memory.")

# In-memory fallback a capacità delimitata (max 200 elementi) per prevenire memory leaks
notifications_log = deque(maxlen=200)
notif_counter = 0
log_lock = threading.Lock()

def save_notification(user_id, notification_type, message, data=None):
    """Salva la notifica su DynamoDB (con encryption at-rest KMS) e in fallback in-memory"""
    user_id_str = str(user_id) if user_id else "system"
    now_iso = datetime.now(timezone.utc).isoformat()
    notif_id = str(uuid.uuid4())
    
    # Sort Key composta con ID univoco per evitare collisioni su timestamp identici
    timestamp_key = f"{now_iso}#{notif_id[:8]}"
    
    item = {
        'user_id': user_id_str,
        'timestamp': timestamp_key,
        'created_at': now_iso,
        'status_scope': 'GLOBAL',
        'notification_id': notif_id,
        'id': notif_id,
        'type': notification_type,
        'message': message,
        'read': False,
        'data': json.dumps(data) if data is not None and not isinstance(data, str) else str(data or "")
    }

    # Salva su DynamoDB
    if dynamodb_table:
        try:
            dynamodb_table.put_item(Item=item)
        except Exception as e:
            print(f"[ERROR] Errore salvataggio su DynamoDB: {e}")

    # Salva nel buffer a rotazione in-memory
    global notif_counter
    with log_lock:
        notif_counter += 1
        notifications_log.append({
            'id': notif_counter,
            'notification_id': notif_id,
            'user_id': user_id_str,
            'type': notification_type,
            'message': message,
            'timestamp': now_iso,
            'created_at': now_iso,
            'data': data
        })

def get_all_notifications_from_store(limit=50):
    """Recupera le notifiche recenti: interroga il GSI AllNotificationsIndex su DynamoDB con ordinamento cronologico perfetto e fallback su scan/in-memory"""
    if dynamodb_table:
        try:
            # Query ottimizzata O(1) sul Global Secondary Index
            response = dynamodb_table.query(
                IndexName='AllNotificationsIndex',
                KeyConditionExpression='status_scope = :scope',
                ExpressionAttributeValues={':scope': 'GLOBAL'},
                ScanIndexForward=False,
                Limit=limit
            )
            items = response.get('Items', [])
            if items:
                return sanitize_dynamodb_data(items)
        except Exception as gsi_err:
            print(f"[WARN] Query su GSI AllNotificationsIndex fallita o indice in creazione ({gsi_err}). Tentativo fallback con scan...")
            try:
                response = dynamodb_table.scan(Limit=limit)
                items = response.get('Items', [])
                items.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
                if items:
                    return sanitize_dynamodb_data(items)
            except Exception as scan_err:
                print(f"[ERROR] Errore scan DynamoDB: {scan_err}")

    with log_lock:
        if len(notifications_log) > 0:
            return list(reversed(list(notifications_log)))[:limit]

    return []

def get_user_notifications_from_store(user_id, limit=50):
    """Recupera le notifiche per uno specifico utente da DynamoDB (inclusi gli alert di sistema broadcast)"""
    if dynamodb_table and user_id:
        try:
            response = dynamodb_table.query(
                KeyConditionExpression='user_id = :uid',
                ExpressionAttributeValues={':uid': str(user_id)},
                ScanIndexForward=False,
                Limit=limit
            )
            items = response.get('Items', [])
            if str(user_id) != 'system':
                try:
                    sys_res = dynamodb_table.query(
                        KeyConditionExpression='user_id = :uid',
                        ExpressionAttributeValues={':uid': 'system'},
                        ScanIndexForward=False,
                        Limit=20
                    )
                    items.extend(sys_res.get('Items', []))
                    items.sort(key=lambda x: x.get('timestamp', ''), reverse=True)
                except Exception as sys_err:
                    print(f"[WARN] Errore query notifiche broadcast system: {sys_err}")

            return sanitize_dynamodb_data(items[:limit])
        except Exception as e:
            print(f"[ERROR] Errore query DynamoDB per user {user_id}: {e}")

    with log_lock:
        return [n for n in reversed(list(notifications_log)) if n.get('user_id') in (str(user_id), 'system')][:limit]

# --- ENDPOINTS HTTP ---

@app_flask.route('/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'ok', 'service': 'notification-service', 'timestamp': datetime.now(timezone.utc).isoformat()}), 200

@app_flask.route('/api/notifications/health', methods=['GET'])
def api_health_check():
    return jsonify({'status': 'ok', 'service': 'notification-service', 'timestamp': datetime.now(timezone.utc).isoformat()}), 200

@app_flask.route('/api/notifications', methods=['GET'])
def get_notifications():
    user_id = request.args.get('user_id')
    if user_id:
        results = get_user_notifications_from_store(user_id)
    else:
        results = get_all_notifications_from_store()
    return jsonify(results), 200

@app_flask.route('/api/notifications', methods=['POST'])
def create_notification():
    try:
        data = request.get_json() or {}
        event_type = data.get('type')
        message = data.get('message')
        user_id = data.get('user_id', 'system')
        payload = data.get('data')
        
        if not event_type or not message:
            return jsonify({'error': 'type and message are required'}), 400
            
        save_notification(user_id, event_type, message, payload)
        return jsonify({'message': 'Notification logged successfully'}), 201
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- RABBITMQ CONSUMER ---

def process_booking_event(ch, method, properties, body):
    try:
        event = json.loads(body.decode())
        event_type = event.get('type')
        data = event.get('data', {})

        print(f"\n[NOTIFICA EVENTO BOOKING] Tipo: {event_type}")

        booking_info = data.get('booking', {}) if 'booking' in data else data
        if not isinstance(booking_info, dict):
            booking_info = {}
            
        client_id = booking_info.get('client_id')
        client_id_short = client_id[:8] if client_id else 'unknown'
        
        service_id = booking_info.get('service_id')
        service_id_short = service_id[:8] if service_id else 'unknown'
        
        employee_id = booking_info.get('employee_id')
        employee_id_short = employee_id[:8] if employee_id else 'unknown'
        
        booking_time = booking_info.get('booking_time', 'unknown')
        price = booking_info.get('price') or booking_info.get('original_price') or '0'
        refund_amount = booking_info.get('refundAmount') or data.get('refundAmount') or '0'
        salon_id = booking_info.get('salon_id') or data.get('salon_id') or 'unknown'

        if event_type == 'BOOKING_CONFIRMED':
            msg = f"[Email] Email a cliente ({client_id_short}...): Prenotazione confermata per il servizio {service_id_short}... alle {booking_time}. Pagato: {price}€."
            print(msg)
            save_notification(client_id, event_type, msg, booking_info)
            
            msg2 = f"[Notifica Dipendente] ({employee_id_short}...): Nuovo appuntamento in agenda alle {booking_time}."
            print(msg2)
            save_notification(employee_id, event_type, msg2, booking_info)
            
            msg3 = f"[Notifica Salone] ({salon_id[:8] if salon_id else 'unknown'}...): Nuovo appuntamento prenotato alle {booking_time}."
            print(msg3)
            save_notification(salon_id, event_type, msg3, booking_info)

        elif event_type == 'BOOKING_CANCELLED_REGULAR':
            msg = f"[Email] Email a cliente ({client_id_short}...): Prenotazione cancellata. Rimborsato 100% ({refund_amount}€)."
            print(msg)
            save_notification(client_id, event_type, msg, booking_info)
            
            msg2 = f"[Notifica Salone] ({salon_id[:8] if salon_id else 'unknown'}...): L'appuntamento delle {booking_time} è stato annullato."
            print(msg2)
            save_notification(salon_id, event_type, msg2, booking_info)

        elif event_type == 'BOOKING_CANCELLED_LATE':
            msg = f"[Email] Email a cliente ({client_id_short}...): Cancellazione tardiva (<24h). Rimborsato 50% ({refund_amount}€)."
            print(msg)
            save_notification(client_id, event_type, msg, booking_info)
            
            msg2 = f"[Notifica Salone] ({salon_id[:8] if salon_id else 'unknown'}...): Cancellazione tardiva alle {booking_time}. Generato automaticamente un Drop al 50% di sconto ({data.get('drop_price', '0')}€) per limitare la perdita."
            print(msg2)
            save_notification(salon_id, event_type, msg2, booking_info)

        elif event_type == 'EMPLOYEE_UNAVAILABILITY_REGISTERED':
            employee_name = data.get('employee_name', 'Dipendente')
            msg = f"[Notifica Salone]: Il dipendente {employee_name} ha registrato un'indisponibilità per il {data.get('unavailable_date')} dalle {data.get('start_time')[:5]} alle {data.get('end_time')[:5]}."
            print(msg)
            save_notification(data.get('salon_id', 'system'), event_type, msg, data)

        elif event_type == 'CLIENT_REVIEW_CREATED':
            rating = data.get('rating', 5)
            comment = data.get('comment', '')
            msg = f"[Notifica Salone]: Un cliente ha lasciato una valutazione di {rating} stelle: '{comment}'."
            print(msg)
            save_notification(data.get('salon_id', 'system'), event_type, msg, data)

        elif event_type == 'BOOKING_PENDING_REASSIGNMENT':
            msg = f"[Notifica Salone]: Riassegnazione pendente! Un dipendente è diventato indisponibile per il trattamento delle {data.get('booking_time')}."
            print(msg)
            save_notification(data.get('salon_id', 'system'), event_type, msg, data)

        elif event_type == 'EMPLOYEE_SCHEDULE_ASSIGNED':
            msg = f"[Notifica Dipendente]: Ti è stato assegnato o aggiornato un turno per il {data.get('schedule_date')} ({data.get('start_time')[:5]} - {data.get('end_time')[:5]})."
            print(msg)
            save_notification(data.get('employee_id', 'system'), event_type, msg, data)

        ch.basic_ack(delivery_tag=method.delivery_tag)
    except Exception as e:
        print(f"Errore nell'elaborazione dell'evento booking: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

def process_drop_event(ch, method, properties, body):
    try:
        event = json.loads(body.decode())
        event_type = event.get('type')
        data = event.get('data', {})

        print(f"\n[NOTIFICA EVENTO DROP] Tipo: {event_type}")

        if event_type == 'DROP_CREATED':
            salon_id = data.get('salon_id', 'unknown')
            msg = f"[Flash Sale 50% OFF] Notifica push inviata a tutti i clienti vicini al salone {salon_id[:8]}...: 'Prenota al volo il trattamento per il {data.get('booking_time')} a soli {data.get('discounted_price')}€!'"
            print(msg)
            save_notification('system', event_type, msg, data)

        elif event_type == 'DROP_CLAIMED_CONFIRMED':
            client_id = data.get('client_id', 'unknown')
            msg = f"[Drop Assegnato] Email inviata a cliente ({client_id[:8]}...): Complimenti, ti sei aggiudicato il Drop {data.get('drop_id')[:8]}... a {data.get('price')}€."
            print(msg)
            save_notification(client_id, event_type, msg, data)

        ch.basic_ack(delivery_tag=method.delivery_tag)
    except Exception as e:
        print(f"Errore nell'elaborazione dell'evento drop: {e}")
        ch.basic_nack(delivery_tag=method.delivery_tag, requeue=False)

def start_rabbitmq_consumer():
    print(f"Avvio del consumer RabbitMQ ({RABBITMQ_URL.split('@')[-1] if '@' in RABBITMQ_URL else RABBITMQ_URL})...")
    while True:
        try:
            # pika gestisce nativamente amqps:// con TLS
            parameters = pika.URLParameters(RABBITMQ_URL)
            connection = pika.BlockingConnection(parameters)
            channel = connection.channel()

            channel.queue_declare(queue='booking.events', durable=True)
            channel.queue_declare(queue='drop.events', durable=True)

            channel.basic_qos(prefetch_count=1)
            channel.basic_consume(queue='booking.events', on_message_callback=process_booking_event)
            channel.basic_consume(queue='drop.events', on_message_callback=process_drop_event)

            print("Notification Service (RabbitMQ Consumer) connesso e pronto.")
            channel.start_consuming()

        except pika.exceptions.AMQPConnectionError:
            print("Connessione a RabbitMQ fallita. Riprovo tra 5 secondi...")
            time.sleep(5)
        except Exception as e:
            print(f"Errore imprevisto consumer: {e}. Riavvio...")
            time.sleep(5)

def main():
    consumer_thread = threading.Thread(target=start_rabbitmq_consumer)
    consumer_thread.daemon = True
    consumer_thread.start()

    port = int(os.environ.get('PORT', 3004))
    print(f"Avvio del server API notifiche sulla porta {port}...")
    app_flask.run(host='0.0.0.0', port=port, debug=False, use_reloader=False)

if __name__ == '__main__':
    main()
