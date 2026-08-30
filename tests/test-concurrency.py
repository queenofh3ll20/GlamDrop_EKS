import json
import urllib.request
import urllib.error
import time
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

import os
import sys

ALB_URL = os.environ.get('ALB_URL')
if ALB_URL:
    ALB_URL = ALB_URL.rstrip('/')
    AUTH_URL = os.environ.get('AUTH_URL', ALB_URL)
    BOOKING_URL = os.environ.get('BOOKING_URL', ALB_URL)
    DROP_URL = os.environ.get('DROP_URL', ALB_URL)
else:
    BASE_HOST = os.environ.get('BASE_HOST', 'localhost')
    if BASE_HOST in ('localhost', '127.0.0.1'):
        AUTH_URL = os.environ.get('AUTH_URL', f"http://{BASE_HOST}:3001")
        BOOKING_URL = os.environ.get('BOOKING_URL', f"http://{BASE_HOST}:3002")
        DROP_URL = os.environ.get('DROP_URL', f"http://{BASE_HOST}:3003")
    else:
        AUTH_URL = os.environ.get('AUTH_URL', f"http://{BASE_HOST}:30001")
        BOOKING_URL = os.environ.get('BOOKING_URL', f"http://{BASE_HOST}:30002")
        DROP_URL = os.environ.get('DROP_URL', f"http://{BASE_HOST}:30003")

def make_request(url, method="GET", headers=None, data=None):
    if headers is None:
        headers = {}
    if data is not None:
        data_bytes = json.dumps(data).encode("utf-8")
        headers["Content-Type"] = "application/json"
    else:
        data_bytes = None

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_data = json.loads(e.read().decode("utf-8"))
        except Exception:
            err_data = e.reason
        return e.code, err_data
    except Exception as e:
        return 500, str(e)

def run_test():
    print("=== INIZIO TEST FLUSSO GLAMDROP E CONCORRENZA ===")

    # 1. Registrazione Salon Manager
    manager_email = f"manager_{int(time.time())}@test.com"
    register_manager_payload = {
        "email": manager_email,
        "password": "Password123!",
        "first_name": "Mario",
        "last_name": "Rossi",
        "phone": "+393331234567",
        "name": "Glamour Salone",
        "street": "Via Torino 12",
        "city": "Milano",
        "latitude": 45.4642,
        "longitude": 9.1900,
        "description": "Salone di bellezza esclusivo"
    }
    
    print("\n[1] Registrazione Salon Manager...")
    status, res = make_request(f"{AUTH_URL}/api/auth/salon/register", "POST", data=register_manager_payload)
    if status != 201:
        print(f"Errore registrazione manager: {res}")
        return
    salon_id = res["salon"]["id"]
    print(f"Salone creato con ID: {salon_id}")

    # Login Manager
    status, res = make_request(f"{AUTH_URL}/api/auth/salon/login", "POST", data={
        "email": manager_email,
        "password": "Password123!"
    })
    manager_token = res["token"]
    manager_headers = {"Authorization": f"Bearer {manager_token}"}

    # 2. Registrazione Estetista (Dipendente)
    print("\n[2] Registrazione Estetista...")
    employee_email = f"estetista_{int(time.time())}@test.com"
    status, res = make_request(f"{AUTH_URL}/api/auth/employee/register", "POST", data={
        "email": employee_email,
        "password": "Password123!",
        "first_name": "Anna",
        "last_name": "Verdi",
        "phone": "+393337654321",
        "salon_id": salon_id,
        "specialization": "Trattamenti Corpo"
    })
    if status != 201:
        print(f"Errore registrazione dipendente: {res}")
        return
    employee_id = res["employee_id"]
    print(f"Estetista registrata con ID: {employee_id}")

    # 3. Impostazione Orari Estetista (Oggi)
    print("\n[3] Configurazione Orario Lavorativo...")
    today_date = datetime.now().strftime("%Y-%m-%d")
    status, res = make_request(f"{BOOKING_URL}/api/schedules", "POST", headers=manager_headers, data={
        "employee_id": employee_id,
        "schedule_date": today_date,
        "start_time": "08:00:00",
        "end_time": "23:00:00"
    })
    if status != 200:
        print(f"Errore impostazione orario: {res}")
        return
    print("Orario configurato: 08:00 - 23:00")

    # 4. Recupero Categoria e Creazione Servizio
    print("\n[4] Recupero categorie e creazione servizio...")
    status, categories = make_request(f"{BOOKING_URL}/api/catalog/categories")
    corpo_cat = next((c for c in categories if c["name"] == "Corpo"), categories[0])
    
    status, service = make_request(f"{BOOKING_URL}/api/catalog/services", "POST", headers=manager_headers, data={
        "category_id": corpo_cat["id"],
        "name": "Trattamento Drenante Corpo",
        "duration_minutes": 60,
        "price": 80.00
    })
    if status != 201:
        print(f"Errore creazione servizio: {service}")
        return
    service_id = service["id"]
    print(f"Servizio '{service['name']}' creato. Prezzo: {service['price']}€")

    # 5. Registrazione e Login Cliente Principale
    print("\n[5] Registrazione Cliente per prenotazione standard...")
    client_email = f"cliente_{int(time.time())}@test.com"
    status, res = make_request(f"{AUTH_URL}/api/auth/client/register", "POST", data={
        "email": client_email,
        "password": "Password123!",
        "first_name": "Giulia",
        "last_name": "Bianchi",
        "phone": "+393339999999"
    })
    status, res = make_request(f"{AUTH_URL}/api/auth/client/login", "POST", data={
        "email": client_email,
        "password": "Password123!"
    })
    client_token = res["token"]
    client_headers = {"Authorization": f"Bearer {client_token}"}

    # 6. Effettua Prenotazione Standard (entro 24h per poter innescare il drop)
    # Impostiamo l'appuntamento a 4 ore nel futuro
    booking_time = (datetime.now() + timedelta(hours=4)).strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n[6] Creazione Prenotazione Standard alle ore {booking_time}...")
    status, booking = make_request(f"{BOOKING_URL}/api/bookings", "POST", headers=client_headers, data={
        "service_id": service_id,
        "employee_id": employee_id,
        "booking_time": booking_time
    })
    if status != 201:
        print(f"Errore prenotazione: {booking}")
        return
    booking_id = booking["id"]
    print(f"Prenotazione confermata con ID: {booking_id}. Stato pagamento: {booking['payment_status']}")

    # 7. Cancellazione Tardiva (genera rimborso 50% e Drop automatico al 50% del prezzo)
    print("\n[7] Cancellazione Tardiva (< 24 ore dall'evento)...")
    status, cancel_res = make_request(f"{BOOKING_URL}/api/bookings/{booking_id}/cancel", "POST", headers=client_headers)
    if status != 200:
        print(f"Errore cancellazione: {cancel_res}")
        return
    print(f"Risultato: {cancel_res['message']}")
    print(f"Rimborso erogato: {cancel_res['refunded_amount']}€ (50% di {booking['price']}€)")

    # Attendiamo un secondo affinché l'evento sia elaborato da RabbitMQ ed il Drop sia inserito in cache Redis e DB
    print("In attesa dell'elaborazione asincrona del Drop...")
    time.sleep(2)

    # 8. Recupero dei Drop Disponibili
    print("\n[8] Recupero del Drop generato automaticamente...")
    status, drops = make_request(f"{DROP_URL}/api/drops")
    if len(drops) == 0:
        print("Nessun drop disponibile trovato. Errore nella catena asincrona.")
        return
    
    # Trova il drop relativo alla nostra estetista
    target_drop = next((d for d in drops if d["employee_id"] == employee_id), None)
    if not target_drop:
        print("Drop specifico non trovato.")
        return
    drop_id = target_drop["id"]
    print(f"Drop trovato! ID: {drop_id}, Prezzo Scontato: {target_drop['discounted_price']}€ (50% di sconto)")

    # 9. Registrazione di 50 Clienti Concorrenti
    print("\n[9] Registrazione rapida di 50 clienti concorrenti per simulare l'assalto (Thundering Herd)...")
    clients_tokens = []
    
    def register_and_login_client(i):
        email = f"herd_client_{i}_{int(time.time())}@test.com"
        make_request(f"{AUTH_URL}/api/auth/client/register", "POST", data={
            "email": email,
            "password": "Password123!",
            "first_name": f"User_{i}",
            "last_name": "Test",
            "phone": "+393330000000"
        })
        s, r = make_request(f"{AUTH_URL}/api/auth/client/login", "POST", data={
            "email": email,
            "password": "Password123!"
        })
        return r.get("token")

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(register_and_login_client, i) for i in range(50)]
        for fut in as_completed(futures):
            token = fut.result()
            if token:
                clients_tokens.append(token)

    print(f"Pronti {len(clients_tokens)} client per simulare il picco di richieste simultanee.")

    # 10. Esecuzione del Test di Concorrenza (Thundering Herd)
    print(f"\n[10] LANCIO SIMULTANEO DI {len(clients_tokens)} RICHIESTE DI ACQUISTO DEL DROP {drop_id}...")
    
    results = []

    def claim_drop(token, client_index):
        url = f"{DROP_URL}/api/drops/{drop_id}/claim"
        headers = {"Authorization": f"Bearer {token}"}
        # Misuriamo il tempo di risposta
        start_time = time.time()
        status_code, response_body = make_request(url, "POST", headers=headers)
        end_time = time.time()
        elapsed = (end_time - start_time) * 1000 # ms
        return client_index, status_code, response_body, elapsed

    # Avviamo le chiamate in parallelo usando un ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=50) as executor:
        futures = [executor.submit(claim_drop, token, idx) for idx, token in enumerate(clients_tokens)]
        for fut in as_completed(futures):
            results.append(fut.result())

    # Analisi dei Risultati
    success_claims = []
    conflict_claims = []
    other_claims = []

    for idx, status_code, body, elapsed in results:
        if status_code == 202:
            success_claims.append((idx, elapsed))
        elif status_code == 409:
            conflict_claims.append((idx, elapsed))
        else:
            other_claims.append((idx, status_code, body, elapsed))

    print("\n--- RISULTATI DELLA SIMULAZIONE ---")
    print(f"Richieste totali effettuate: {len(results)}")
    print(f"Richieste andate a buon fine (202 Accepted): {len(success_claims)}")
    print(f"Richieste rifiutate (409 Conflict): {len(conflict_claims)}")
    print(f"Altre risposte/Errori: {len(other_claims)}")

    if len(success_claims) == 1:
        winner_idx, winner_time = success_claims[0]
        print(f"\n[OK] SUCCESSO! Esattamente 1 utente (User_{winner_idx}) ha acquistato il drop in {winner_time:.1f}ms.")
        print("   Tutti gli altri 49 utenti sono stati rifiutati all'istante con 409 Conflict.")
        
        # Calcoliamo i tempi medi
        avg_conflict_time = sum(c[1] for c in conflict_claims) / len(conflict_claims)
        print(f"   Tempo medio di risposta per i rifiuti (carico gestito da Redis): {avg_conflict_time:.1f}ms")
    else:
        print(f"\n[ERRORE] Trovate {len(success_claims)} prenotazioni andate a buon fine contemporaneamente!")
        print("Questo indica una Race Condition!")

    # Verifichiamo che il drop sia effettivamente claimed nel db
    time.sleep(2) # Attendiamo scrittura del worker
    print("\n[11] Verifica dello stato del Drop nel Database...")
    status, updated_drops = make_request(f"{DROP_URL}/api/drops")
    still_available = [d for d in updated_drops if d["id"] == drop_id]
    if len(still_available) == 0:
        print("[OK] Drop non è più nell'elenco dei disponibili nel DB (Corretto).")
    else:
        print("[ERRORE] Il drop risulta ancora disponibile nel database!")

    # Controlliamo le prenotazioni finali
    status, bookings = make_request(f"{BOOKING_URL}/api/bookings")
    print(f"Totale prenotazioni registrate nel sistema: {len(bookings)}")

if __name__ == "__main__":
    run_test()
