from fastapi.testclient import TestClient

import main
from models.schemas import IncidentResponse
from routers import crew as crew_router
from routers import incident as incident_router


client = TestClient(main.app)


def _sample_response():
    return IncidentResponse(
        incident_id='inc_123',
        decision_path='fallback',
        status='new',
        hospitals=[{
            'id': 'seed_1',
            'name': 'City General',
            'lat': 19.1,
            'lon': 72.9,
            'distance_km': 4.2,
            'eta_minutes': 11,
            'eta_source': 'simulated',
            'capacity': {'available_icu': 8, 'available_beds': 30, 'trauma_centre': True, 'specialties': ['trauma'], 'data_source': 'NHA_simulation'},
            'blood': {'O-': 5, 'data_source': 'simulated_deterministic'},
            'trauma_centre': True,
            'specialties': ['trauma'],
            'source_summary': {'location': 'seed', 'eta': 'simulated', 'capacity': 'NHA_simulation', 'blood': 'simulated_deterministic'},
        }],
        scores=[{'name': 'City General', 'composite_score': 91, 'sub_scores': {'eta': 90, 'capacity': 88, 'trauma': 100, 'blood': 70}}],
        assignments=[{'hospital': 'City General', 'patients_assigned': 2, 'severity': 'critical', 'injury_type': 'trauma', 'reason': 'Closest trauma destination.'}],
        warnings=[],
        reasoning='Closest trauma destination.',
        elapsed_s=0.42,
        agencies=[],
    )


def test_incident_response_includes_hospital_capabilities(monkeypatch):
    async def fake_discover_hospitals(*args, **kwargs):
        return {'hospitals': [{'id': 'seed_1', 'name': 'City General', 'lat': 19.1, 'lon': 72.9, 'data_source': 'seed'}], 'radius_km': 15, 'expanded': False}

    async def fake_discover_agencies(*args, **kwargs):
        return []

    async def fake_fetch_hospital_data(*args, **kwargs):
        return {
            'City General': {
                'distance_km': 4.2,
                'eta_minutes': 11,
                'eta_source': 'simulated',
                'capacity': {
                    'available_icu': 8,
                    'available_beds': 30,
                    'trauma_centre': True,
                    'specialties': ['trauma', 'neuro'],
                    'data_source': 'NHA_simulation',
                },
                'blood': {'O-': 5, 'data_source': 'simulated_deterministic'},
            },
        }

    async def fake_route(*args, **kwargs):
        return {
            'decision_path': 'fallback',
            'assignments': [{'hospital': 'City General', 'patients_assigned': 2, 'severity': 'critical', 'injury_type': 'trauma', 'reason': 'Closest trauma destination.'}],
            'warnings': [],
            'reasoning': 'Closest trauma destination.',
        }

    async def fake_save_incident(*args, **kwargs):
        return None

    monkeypatch.setattr(incident_router, 'discover_hospitals_adaptive', fake_discover_hospitals)
    monkeypatch.setattr(incident_router, 'discover_agencies', fake_discover_agencies)
    monkeypatch.setattr(incident_router, 'fetch_hospital_data', fake_fetch_hospital_data)
    monkeypatch.setattr(incident_router, 'score_all', lambda *_args, **_kwargs: [{'name': 'City General', 'composite_score': 91, 'sub_scores': {'eta': 90, 'capacity': 88, 'trauma': 100, 'blood': 70}}])
    monkeypatch.setattr(incident_router, '_route', fake_route)
    monkeypatch.setattr(incident_router.firestore_client, 'save_incident', fake_save_incident)

    response = client.post('/api/incident', json={
        'lat': 19.1,
        'lon': 72.9,
        'patients': [{'severity': 'critical', 'count': 2, 'injury_type': 'trauma'}],
    })

    assert response.status_code == 200
    hospital = response.json()['hospitals'][0]
    assert hospital['capacity']['available_icu'] == 8
    assert hospital['blood']['O-'] == 5
    assert hospital['trauma_centre'] is True
    assert hospital['specialties'] == ['trauma', 'neuro']
    assert hospital['source_summary']['capacity'] == 'NHA_simulation'


def test_scene_consensus_endpoint_avoids_double_counting(monkeypatch):
    async def fake_reports(*args, **kwargs):
        return [
            {
                'unit_id': 'AMB_1',
                'estimated_casualties': 5,
                'patient_groups': [
                    {'severity': 'critical', 'count': 2, 'injury_type': 'trauma'},
                    {'severity': 'moderate', 'count': 2, 'injury_type': None},
                    {'severity': 'minor', 'count': 1, 'injury_type': None},
                ],
                'hazard_flags': ['fuel leak'],
            },
            {
                'unit_id': 'AMB_2',
                'estimated_casualties': 5,
                'patient_groups': [
                    {'severity': 'critical', 'count': 2, 'injury_type': 'trauma'},
                    {'severity': 'moderate', 'count': 2, 'injury_type': None},
                    {'severity': 'minor', 'count': 1, 'injury_type': None},
                ],
                'hazard_flags': ['fuel leak', 'glass'],
            },
        ]

    monkeypatch.setattr(incident_router.firestore_client, 'get_scene_assessments', fake_reports)

    response = client.get('/api/scene-assessments/inc_123')
    assert response.status_code == 200
    aggregated = response.json()['aggregated']
    counts = {group['severity']: group['count'] for group in aggregated['consensus_patient_groups']}

    assert aggregated['report_count'] == 2
    assert counts == {'critical': 2, 'moderate': 2, 'minor': 1}
    assert aggregated['total_estimated'] == 5
    assert aggregated['hazard_flags'] == ['fuel leak', 'glass']


def test_crew_status_endpoint_tracks_full_lifecycle(monkeypatch):
    saved_assignments = []
    recorded_dispatches = []
    updated_assignments = []
    recorded_statuses = []

    async def fake_save_assignment(unit_id, data):
        saved_assignments.append((unit_id, data))

    async def fake_record_dispatch(incident_id, unit_id, assignment):
        recorded_dispatches.append((incident_id, unit_id, assignment))

    async def fake_update_assignment(unit_id, patch):
        updated_assignments.append((unit_id, patch))

    async def fake_record_status(incident_id, unit_id, status, *, notes='', timestamp=None):
        recorded_statuses.append((incident_id, unit_id, status, notes, timestamp))

    monkeypatch.setattr(crew_router.firestore_client, 'save_crew_assignment', fake_save_assignment)
    monkeypatch.setattr(crew_router.firestore_client, 'record_incident_dispatch', fake_record_dispatch)
    monkeypatch.setattr(crew_router.firestore_client, 'update_crew_assignment', fake_update_assignment)
    monkeypatch.setattr(crew_router.firestore_client, 'record_crew_status', fake_record_status)

    dispatch = client.post('/api/crew/dispatch', json={
        'unit_id': 'AMB_1',
        'incident_id': 'inc_123',
        'hospital_name': 'City General',
        'hospital_lat': 19.1,
        'hospital_lon': 72.9,
        'incident_lat': 19.0,
        'incident_lon': 72.8,
        'eta_minutes': 12,
        'patients_assigned': 2,
        'severity': 'critical',
        'injury_type': 'trauma',
        'reason': 'Closest trauma destination.',
        'available_icu': 8,
        'trauma_centre': True,
        'specialties': ['trauma'],
    })

    assert dispatch.status_code == 200
    assert saved_assignments[0][0] == 'AMB_1'
    assert recorded_dispatches[0][0] == 'inc_123'

    statuses = [
        ('en_route', '2026-04-17T01:00:00Z', 'Crew acknowledged dispatch.'),
        ('on_scene', '2026-04-17T01:10:00Z', 'Crew arrived on scene.'),
        ('transporting', '2026-04-17T01:25:00Z', 'Crew departed scene.'),
        ('closed', '2026-04-17T01:45:00Z', 'Patients handed over.'),
    ]

    for status, timestamp, notes in statuses:
        response = client.patch('/api/crew/AMB_1/status', json={
            'incident_id': 'inc_123',
            'status': status,
            'timestamp': timestamp,
            'notes': notes,
        })
        assert response.status_code == 200

    assert updated_assignments[0][1]['acknowledged_at'] == '2026-04-17T01:00:00Z'
    assert updated_assignments[1][1]['on_scene_at'] == '2026-04-17T01:10:00Z'
    assert updated_assignments[2][1]['transporting_at'] == '2026-04-17T01:25:00Z'
    assert updated_assignments[3][1]['closed_at'] == '2026-04-17T01:45:00Z'
    assert [entry[2] for entry in recorded_statuses] == ['en_route', 'on_scene', 'transporting', 'closed']


def test_reroute_requires_confirmation_and_records_history(monkeypatch):
    recorded = []

    async def fake_execute(*args, **kwargs):
        return _sample_response(), {'status': 'new'}

    async def fake_record_reroute(incident_id, reroute, snapshot):
        recorded.append((incident_id, reroute, snapshot))

    monkeypatch.setattr(incident_router, '_execute_incident', fake_execute)
    monkeypatch.setattr(incident_router.firestore_client, 'record_incident_reroute', fake_record_reroute)

    rejected = client.post('/api/incidents/inc_123/reroute', json={
        'lat': 19.1,
        'lon': 72.9,
        'patients': [{'severity': 'critical', 'count': 2, 'injury_type': 'trauma'}],
        'confirm_consensus': False,
    })
    assert rejected.status_code == 400

    accepted = client.post('/api/incidents/inc_123/reroute', json={
        'lat': 19.1,
        'lon': 72.9,
        'patients': [{'severity': 'critical', 'count': 2, 'injury_type': 'trauma'}],
        'confirm_consensus': True,
        'source': 'scene_consensus',
        'reason': 'Dispatcher confirmed reroute.',
        'report_count': 2,
    })

    assert accepted.status_code == 200
    assert recorded[0][0] == 'inc_123'
    assert recorded[0][1]['source'] == 'scene_consensus'
    assert recorded[0][1]['report_count'] == 2
