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
else:
    BASE_HOST = os.environ.get('BASE_HOST', 'localhost')
    if BASE_HOST in ('localhost', '127.0.0.1'):
        AUTH_URL = os.environ.get('AUTH_URL', f"http://{BASE_HOST}:3001")
        BOOKING_URL = os.environ.get('BOOKING_URL', f"http://{BASE_HOST}:3002")
    else:
        AUTH_URL = os.environ.get('AUTH_URL', f"http://{BASE_HOST}:30001")
        BOOKING_URL = os.environ.get('BOOKING_URL', f"http://{BASE_HOST}:30002")

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
    print("=== INIZIO TEST OVERLAP PRENOTAZIONI E RACE CONDITIONS ===")

    # 1. Register Salon Manager
    manager_email = f"mgr_overlap_{int(time.time())}@test.com"
    register_manager_payload = {
        "email": manager_email,
        "password": "Password123!",
        "first_name": "Test",
        "last_name": "Manager",
        "phone": "+393339999998",
        "name": "Salone Overlap Test",
        "street": "Via Milano 12",
        "city": "Milano",
        "latitude": 45.4642,
        "longitude": 9.1900,
        "description": "Test overlap"
    }
    
    status, res = make_request(f"{AUTH_URL}/api/auth/salon/register", "POST", data=register_manager_payload)
    if status != 201:
        print(f"Errore registrazione manager: {res}")
        return
    salon_id = res["salon"]["id"]

    # Login Manager
    status, res = make_request(f"{AUTH_URL}/api/auth/salon/login", "POST", data={
        "email": manager_email,
        "password": "Password123!"
    })
    manager_token = res["token"]
    manager_headers = {"Authorization": f"Bearer {manager_token}"}

    # 2. Register Employee
    employee_email = f"emp_overlap_{int(time.time())}@test.com"
    status, res = make_request(f"{AUTH_URL}/api/auth/employee/register", "POST", data={
        "email": employee_email,
        "password": "Password123!",
        "first_name": "Sofia",
        "last_name": "Unghie",
        "phone": "+393338888888",
        "salon_id": salon_id,
        "specialization": "Unghie"
    })
    if status != 201:
        print(f"Errore registrazione dipendente: {res}")
        return
    employee_id = res["employee_id"]

    # 3. Set Working Shift for tomorrow (future date to avoid block)
    tomorrow_date = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    status, res = make_request(f"{BOOKING_URL}/api/schedules", "POST", headers=manager_headers, data={
        "employee_id": employee_id,
        "schedule_date": tomorrow_date,
        "start_time": "08:00:00",
        "end_time": "18:00:00"
    })
    if status != 200:
        print(f"Errore impostazione orario: {res}")
        return

    # 4. Create 45 minutes service
    status, categories = make_request(f"{BOOKING_URL}/api/catalog/categories")
    unghie_cat = next((c for c in categories if c["name"] == "Unghie"), categories[0])
    
    status, service = make_request(f"{BOOKING_URL}/api/catalog/services", "POST", headers=manager_headers, data={
        "category_id": unghie_cat["id"],
        "name": "Manicure Completa 45min",
        "duration_minutes": 45,
        "price": 35.00
    })
    if status != 201:
        print(f"Errore creazione servizio: {service}")
        return
    service_id = service["id"]

    # 5. Register and login Client 1
    client1_email = f"c1_overlap_{int(time.time())}@test.com"
    make_request(f"{AUTH_URL}/api/auth/client/register", "POST", data={
        "email": client1_email,
        "password": "Password123!",
        "first_name": "Client",
        "last_name": "Uno",
        "phone": "+393331111111"
    })
    status, res = make_request(f"{AUTH_URL}/api/auth/client/login", "POST", data={
        "email": client1_email,
        "password": "Password123!"
    })
    token1 = res["token"]
    headers1 = {"Authorization": f"Bearer {token1}"}

    # 6. Register and login Client 2
    client2_email = f"c2_overlap_{int(time.time())}@test.com"
    make_request(f"{AUTH_URL}/api/auth/client/register", "POST", data={
        "email": client2_email,
        "password": "Password123!",
        "first_name": "Client",
        "last_name": "Due",
        "phone": "+393332222222"
    })
    status, res = make_request(f"{AUTH_URL}/api/auth/client/login", "POST", data={
        "email": client2_email,
        "password": "Password123!"
    })
    token2 = res["token"]
    headers2 = {"Authorization": f"Bearer {token2}"}

    # Test case 1: Sequential overlapping booking validation
    # Client 1 books at 09:00 (covers 09:00 to 09:45)
    booking1_time = f"{tomorrow_date} 09:00:00"
    print(f"\n[TEST 1] Client 1 prenota alle {booking1_time} (durata 45 min)...")
    status, res1 = make_request(f"{BOOKING_URL}/api/bookings", "POST", headers=headers1, data={
        "service_id": service_id,
        "employee_id": employee_id,
        "booking_time": booking1_time
    })
    if status == 201:
        print("[OK] Prenotazione 1 confermata con successo.")
    else:
        print(f"[ERRORE] Errore prenotazione 1: {res1}")
        return

    # Client 2 tries to book at 09:15 (overlapping, should fail)
    booking2_time = f"{tomorrow_date} 09:15:00"
    print(f"[TEST 1] Client 2 prova a prenotare alle {booking2_time} (dovrebbe fallire)...")
    status, res2 = make_request(f"{BOOKING_URL}/api/bookings", "POST", headers=headers2, data={
        "service_id": service_id,
        "employee_id": employee_id,
        "booking_time": booking2_time
    })
    if status == 400 and "già prenotato" in res2.get("error", "").lower():
        print("[OK] CORRETTO! Prenotazione rifiutata con errore 400:", res2["error"])
    else:
        print(f"[ERRORE] Stato inatteso per la prenotazione sovrapposta: {status}, Risposta: {res2}")

    # Test case 2: Concurrent booking race condition check
    # We will try to book at 11:00 simultaneously with Client 1 and Client 2
    booking3_time = f"{tomorrow_date} 11:00:00"
    print(f"\n[TEST 2] Lancio di 2 richieste simultanee per la stessa fascia oraria delle {booking3_time}...")
    
    def post_booking(headers):
        return make_request(f"{BOOKING_URL}/api/bookings", "POST", headers=headers, data={
            "service_id": service_id,
            "employee_id": employee_id,
            "booking_time": booking3_time
        })

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(post_booking, headers1),
            executor.submit(post_booking, headers2)
        ]
        results = [f.result() for f in futures]

    successes = [r for r in results if r[0] == 201]
    failures = [r for r in results if r[0] == 400]

    print(f"Risultati concorrenza: {len(successes)} successi, {len(failures)} fallimenti.")
    if len(successes) == 1 and len(failures) == 1:
        print("[OK] SUCCESSO! Esattamente 1 prenotazione confermata e 1 fallita. Race condition evitata grazie al lock transazionale!")
    else:
        print(f"[ERRORE] La race condition non è gestita correttamente: {results}")

if __name__ == "__main__":
    run_test()
