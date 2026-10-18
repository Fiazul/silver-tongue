#!/usr/bin/env python3
"""Deterministic stdlib physics ledger and numeric lore renderer (no live data)."""
import argparse
from datetime import date, timedelta
import json
import math
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
C = 299792458.0
YEAR = 365.25 * 86400
LY = C * YEAR
G = 6.67430e-11
MSUN = 1.98847e30
A = 9.81
K = C / A / YEAR


def four_burn(years):
    eta = math.asinh(years / (4 * K))
    gamma = math.cosh(eta)
    proper = 4 * K * eta
    return dict(earth_years=years, ship_years=proper, peak_gamma=gamma,
                peak_beta=math.tanh(eta), turnaround_ly=2*K*(gamma-1),
                path_ly=4*K*(gamma-1), rapidity_per_burn=eta,
                one_way_delta_eta=2*eta, round_trip_delta_eta=4*eta,
                awake_years=3.0, cryo_years=proper-3,
                earth_body_ratio=years/3, earth_ship_ratio=years/proper)


def leg(distance):
    gamma = 1 + distance/(2*K)
    return dict(distance_ly=distance, earth_years=2*K*math.sqrt(gamma*gamma-1),
                ship_years=2*K*math.acosh(gamma), peak_gamma=gamma,
                peak_beta=math.sqrt(1-1/gamma**2))


def vector(d, ra, dec):
    a,b=math.radians(ra),math.radians(dec)
    return [d*math.cos(b)*math.cos(a),d*math.cos(b)*math.sin(a),d*math.sin(b)]


def compute():
    p = dict(constants=dict(c_m_s=C, year_s=YEAR, ly_m=LY, a_m_s2=A,
             a_ly_yr2=A*YEAR/C, c_over_a_years=K, G=G, solar_mass_kg=MSUN,
             proton_MeV=938.27208816, joule_per_eV=1.602176634e-19,
             tonne_TNT_J=4.184e9, sigma=5.670374419e-8),
             trip1=four_burn(60), trip2=four_burn(109))
    # Catalogue positions are authored inputs, not generated star discoveries.
    stars=dict(proxima=dict(distance_ly=4.24,ra_deg=217.429,dec_deg=-62.679),
               alpha=dict(distance_ly=4.34,ra_deg=219.902,dec_deg=-60.834),
               luhman=dict(distance_ly=6.51,ra_deg=162.329,dec_deg=-53.319))
    for s in stars.values(): s['xyz_ly']=vector(s['distance_ly'],s['ra_deg'],s['dec_deg'])
    p['catalog']=stars
    pa=math.dist(stars['proxima']['xyz_ly'],stars['alpha']['xyz_ly'])
    al=math.dist(stars['alpha']['xyz_ly'],stars['luhman']['xyz_ly'])
    # A constructive subluminal itinerary, distinct from the minimum four-burn benchmark.
    distances=[4.24,pa,al,30.0,60.0]
    names=['proxima','alpha','luhman','turn','binary']
    legs={name:leg(d) for name,d in zip(names,distances)}
    cruise_earth=sum(v['earth_years'] for v in legs.values())
    dwell=109-cruise_earth
    if dwell <= 0: raise ValueError('Itinerary exceeds Earth-time budget')
    earth=proper=0.0
    for row in legs.values():
        earth+=row['earth_years'];proper+=row['ship_years']
        row.update(arrival_earth_elapsed=earth,arrival_ship_elapsed=proper)
    p['route']=dict(legs=legs, earth_years=109.0, travel_earth_years=cruise_earth,
        local_dwell_years=dwell,ship_years=proper+dwell, awake_years=3.0,
        cryo_years=proper+dwell-3, path_ly=sum(distances),
        peak_gamma=max(r['peak_gamma'] for r in legs.values()),
        binary_offset_from_luhman_ly=30.0, probe_offset_from_luhman_ly=30.0,
        # Last few weeks are local repair; supported by the salvage service budget.
        salvage_to_transit_days=30.0, reentry_months=5.0)
    p['rocket']={}
    for trip in ('trip1','trip2'):
        p['rocket'][trip]={}
        for name,ve in dict(chemical=4500/C,orion=.03,daedalus=.04,best_fusion=.1,photon=1.0).items():
            exponent=p[trip]['one_way_delta_eta']/ve
            twice=2*exponent
            p['rocket'][trip][name]=dict(exhaust_beta=ve,one_way_ln_R=exponent,
                round_trip_ln_R=twice,one_way_log10_R=exponent/math.log(10),
                round_trip_log10_R=twice/math.log(10),
                one_way_R=math.exp(exponent) if exponent<700 else None,
                round_trip_R=math.exp(twice) if twice<700 else None)
    p['medium']={}
    for name,gamma in [('trip1',p['trip1']['peak_gamma']),('trip2',p['trip2']['peak_gamma']),
                       ('route',p['route']['peak_gamma'])]:
        beta=math.sqrt(1-1/gamma**2)
        energy_GeV=(gamma-1)*p['constants']['proton_MeV']/1000
        low=gamma*1e5*beta*C;high=low*10
        dust=(gamma-1)*1e-9*C*C
        # Ship-frame flux gamma*n*v; rough minimum-ionising deposition model.
        stopping_J_per_kg_m2=2e6*1.602176634e-19/10
        p['medium'][name]=dict(gamma=gamma, density_low_cm3=.1,density_high_cm3=1.0,
            proton_GeV=energy_GeV,flux_low_m2_s=low,flux_high_m2_s=high,
            energy_flux_low_W_m2=low*energy_GeV*1e9*1.602176634e-19,
            energy_flux_high_W_m2=high*energy_GeV*1e9*1.602176634e-19,
            dose_low_Gy_day=low*stopping_J_per_kg_m2*86400,
            dose_high_Gy_day=high*stopping_J_per_kg_m2*86400,
            stopping_MeV_per_g_cm2=2.0,dust_mass_kg=1e-9,dust_microgram=1.0,
            dust_J=dust,dust_tonnes_TNT=dust/4.184e9,
            proton_rigidity_Tm=math.sqrt(gamma*gamma-1)*p['constants']['proton_MeV']/1000/.299792458)
    mass=1.4*MSUN; span=10.; tidal_limit=1.
    tidal=lambda r: 2*G*mass*span/r**3/A
    p['tidal']=dict(ns_mass_solar=1.4,ship_span_m=span,at_1000_km_g=tidal(1e6),
        at_50_km_g=tidal(5e4),rated_g=tidal_limit,
        minimum_radius_km=(2*G*mass*span/(tidal_limit*A))**(1/3)/1000,
        planned_radius_km=12000.,actual_radius_km=800.,
        planned_g=tidal(1.2e7),actual_g=tidal(8e5),
        binary_separation_km=100000.,binary_component_speed_km_s=math.sqrt(G*mass/(2*1e8))/1000,
        schwarzschild_radius_km=2*G*mass/C**2/1000)
    p['sling']={}
    for name,V in dict(jupiter=13.07,ordinary_binary=30.,white_dwarf=1500.,neutron_binary=.1*C/1000).items():
        b=V*1000/C;incoming=.1
        out=(incoming+2*b+incoming*b*b)/(1+2*incoming*b+b*b)
        p['sling'][name]=dict(orbital_km_s=V,ideal_newtonian_gain_km_s=2*V,
            incoming_beta=incoming,ideal_outgoing_beta=out)
    p['sling']['note']='Ideal reversing scatter off a moving body; real deflection and tidal feasibility are separate.'
    ra1=(6+45/60+8.9/3600)*15;dec1=-(16+42/60+58/3600)
    ra2=(8+16/60+31.4/3600)*15;dec2=-(19+40/60+19.3/3600)
    u=vector(1,ra1,dec1);v=vector(1,ra2,dec2)
    angle=math.acos(max(-1,min(1,sum(a*b for a,b in zip(u,v)))))
    p['sirius']=dict(reference_ra_deg=ra1,reference_dec_deg=dec1,
        observed_ra_deg=ra2,observed_dec_deg=dec2,angle_deg=math.degrees(angle),distance_ly=8.6,
        catalog_distance_ly=8.71,proper_motion_arcsec_yr=1.3,comparison_years=2000.,
        proper_motion_deg=1.3*2000/3600,minimum_displacement_ly=8.6*math.sin(angle),
        fixed_transverse_displacement_ly=8.6*math.tan(angle))
    # Exact radar/light intersection for a ship accelerating away from Sol at 1g.
    impact_after_days=11.
    te=impact_after_days/365.25
    # x(t)=k(sqrt(1+(t/k)^2)-1), light x=t-te => t=(te*(2k-te))/(2*(k-te)).
    received=te*(2*K-te)/(2*(K-te))
    x=received-te
    p['signal']=dict(impact_after_departure_days=impact_after_days,
        received_after_departure_days=received*365.25,delay_days=x*365.25,
        receiver_distance_ly=x, receiver_distance_AU=x*LY/149597870700,
        earth_to_proxima_years=4.24,earth_to_luhman_years=6.51,
        probe_to_luhman_years=30.,sirius_light_years=8.6)
    p['air']=dict(service_hours=3700.,service_days=3700/24,oxygen_kg_person_day=.84,
        crew_initial=5,crew_salvage=1,oxygen_one_kg=3700/24*.84,
        oxygen_five_kg=3700/24*.84*5,
        same_oxygen_five_hours=3700/5,
        survival_days_after_salvage=30.,oxygen_thirty_days_kg=30*.84)
    # Fictional engineering assumptions. Values are inputs, not inferred real technology.
    field=dict(max_k=1e6,idle_W=1e6,W_per_k=10.,ramp_seconds=300.,
        cruise_k=1e6,ship_dry_kg=1e5,fusion_efficiency=.003,fusion_power_W=1e12,
        field_tidal_limit_g=tidal_limit)
    field['max_control_W']=field['idle_W']+field['W_per_k']*(field['max_k']-1)
    field['effective_dry_kg']=field['ship_dry_kg']/field['max_k']
    field['peak_effective_kinetic_J']=(p['route']['peak_gamma']-1)*field['effective_dry_kg']*C*C
    field['restore_at_peak_J']=(p['route']['peak_gamma']-1)*field['ship_dry_kg']*C*C*(1-1/field['max_k'])
    field['control_voyage_J']=field['max_control_W']*p['route']['ship_years']*YEAR
    # No regeneration credit; positive work summed over all acceleration/braking changes.
    field['mechanical_work_J']=sum(2*(r['peak_gamma']-1)*field['effective_dry_kg']*C*C for r in legs.values())
    field['minimum_fusion_fuel_kg']=(field['mechanical_work_J']+field['control_voyage_J'])/(field['fusion_efficiency']*C*C)
    field['fusion_energy_per_kg_J']=field['fusion_efficiency']*C*C
    p['field']=field
    shield=dict(reference_W=1e8,event_percent=117.,rated_percent=150.,event_seconds=120.,
        residual_fraction=.01,frontal_m2=10.,magnetic_B_T=10.,magnetic_length_m=12.)
    shield['event_W']=shield['reference_W']*shield['event_percent']/100
    shield['rated_W']=shield['reference_W']*shield['rated_percent']/100
    shield['event_J']=shield['event_W']*shield['event_seconds']
    shield['rated_utilization_percent']=shield['event_percent']/shield['rated_percent']*100
    shield['rated_margin_W']=shield['rated_W']-shield['event_W']
    shield['rigidity_Tm']=shield['magnetic_B_T']*shield['magnetic_length_m']
    shield['peak_residual_heat_W']=p['medium']['route']['energy_flux_high_W_m2']*shield['frontal_m2']*shield['residual_fraction']
    p['shield']=shield
    rad=dict(emissivity=.9,temperature_K=2000.,waste_heat_W=2e11)
    rad['surface_W_m2']=rad['emissivity']*p['constants']['sigma']*rad['temperature_K']**4
    rad['emitting_area_m2']=rad['waste_heat_W']/rad['surface_W_m2']
    p['radiator']=rad
    p['canon']=dict(birth_year=2010,first_departure_year=2030,first_return_year=2090,
        registry_year=2198,transit_year=2199,calendar_span=2199-2010,claimed_span=340,
        departure_age=2030-2010,return_age=23,transit_age=26,possible_local_age=2026-2010,
        impactor_km=3.2,rover_passengers=3,YR4_size_low_m=53,YR4_size_high_m=67,YR4_historical_percent=4.3,
        solar_superflare_erg=1e34,ozone_model_percent=94.,supernova_pc=8.,supernova_ly=8*3.26156,
        registry='AX-2198-047',departure_date='2090-02-01',impact_date='2090-02-12',
        arrival_local='2026-05-15',room_date='2026-10-15',moon_strike_date='2032-12-22',
        first_departure_date='2030-02-01')
    epoch=date.fromisoformat(p['canon']['departure_date'])
    transit=epoch+timedelta(days=109*365.25)
    # Nominal navigation chronology; local relativistic corrections are below date precision.
    arrivals={key:row['arrival_earth_elapsed'] for key,row in legs.items()}
    elapsed={6:0.,7:received,8:15/365.25,9:arrivals['proxima'],10:arrivals['proxima'],
        11:arrivals['alpha'],12:arrivals['luhman'],13:arrivals['luhman'],
        14:arrivals['turn']+legs['binary']['earth_years']/2,
        15:arrivals['binary'],16:arrivals['binary']+1/365.25,17:arrivals['binary']+2/365.25,
        18:(date(2197,11,1)-epoch).days/365.25,19:(date(2198,1,1)-epoch).days/365.25,
        20:109-30/365.25,21:109-29/365.25,22:109-20/365.25,23:109-10/365.25,24:109.}
    proper_at={6:0.,7:K*math.asinh(received/K),8:K*math.asinh(elapsed[8]/K),
        9:legs['proxima']['arrival_ship_elapsed'],10:legs['proxima']['arrival_ship_elapsed'],
        11:legs['alpha']['arrival_ship_elapsed'],12:legs['luhman']['arrival_ship_elapsed'],
        13:legs['luhman']['arrival_ship_elapsed'],
        14:legs['turn']['arrival_ship_elapsed']+legs['binary']['ship_years']/2,
        15:legs['binary']['arrival_ship_elapsed']}
    p['schedule']={}
    for i,e in elapsed.items():
        proper=proper_at.get(i,proper_at[15]+e-elapsed[15])
        p['schedule'][f'V{i:03}']=dict(earth_date=(epoch+timedelta(days=e*365.25)).isoformat(),
            ship_time=f'V+{proper:.6f} yr (nominal)')
    archived={1:('2089-02-01','commissioning'),2:('2030-02-01','first flight departure'),
              3:('2090-02-01',f'first flight +{p["trip1"]["ship_years"]:.6f} yr'),
              4:('2031-06-01','historical archive'),5:('2032-12-22','historical archive')}
    for i,(dt,clock) in archived.items():p['schedule'][f'V{i:03}']=dict(earth_date=dt,ship_time=clock)
    local_arrival=date.fromisoformat(p['canon']['arrival_local'])
    for i in range(25,39):
        dt=local_arrival if i==25 else local_arrival+timedelta(days=4) if i==26 else date(2026,10,14) if i==27 else date(2026,10,15)
        p['schedule'][f'V{i:03}']=dict(earth_date=dt.isoformat()+' (local; scene dates approximate)',
            ship_time=f'V+{p["route"]["ship_years"]+(dt-local_arrival).days/365.25:.6f} yr (nominal)')
    # Later-authored historical insert: preserve existing log IDs and route clocks.
    flower_date=date(2197,12,1)
    flower_proper=proper_at[15]+(flower_date-epoch).days/365.25-elapsed[15]
    p['schedule']['V039']=dict(earth_date=flower_date.isoformat(),
        ship_time=f'V+{flower_proper:.6f} yr (nominal)')
    p['flower']=dict(eva_window_minutes=40,discovery_minute=22,breach_minute=31,
        ingress_air_minutes=9,ship_years_to_arrival=p['route']['ship_years']-flower_proper)
    p['canon']['transit_date']=transit.isoformat()
    p['assumptions']={
        'trips':'Four equal constant-proper-acceleration burns: outward accel/brake, inward accel/brake; no dwell. Reference clocks, not the multi-system itinerary.',
        'route':'Each catalogue leg and fictional detour is rest-to-rest at 1g; remaining time is local dwell/repairs. Turn point is 30 ly opposite the binary along a line through Luhman, so the last leg is 60 ly and binary/probe are 30 ly from Luhman.',
        'dose':'Ship-frame flux; 2 MeV/(g/cm²) illustrative ionisation stopping power. Gy, not Sv; ignores nuclear cascades, composition, shielding and biological response. Not a transport calculation.',
        'field':'Fictional constitutive law Ekin=(gamma-1)mc²/k while active. No validated covariant stress-energy theory. State changes pay kinetic-energy difference; no free-energy loop permitted. Not a derivation from known relativity.',
        'cryo':'Biological aging assumed suspended in cryo; reversible long-duration human cryo is unproved. Awake time is an input, not predicted by relativity.',
        'shield':'Rigidity is necessary, not sufficient; neutral gas must be ionised first, grains dispersed far upstream, secondaries transported. No guarantee against an arbitrary grain.',
        'tidal':'Newtonian radial gradient approximation outside a single component. Binary perturbations and GR require better modeling; no tidal cancellation by the inertia field.',
        'sling':'Ideal head-on reversal, energy/momentum extracted from moving binary orbital reservoir; near-merger orbit and geometry not generally survivable.'}
    return p


def lookup(values, key):
    value=values
    for part in key.split('.'):value=value[part]
    return value


TOKEN=re.compile(r'\{\{([a-zA-Z0-9_.]+)(?::([^}]+))?\}\}')
# A single-brace dotted ledger path ({canon.transit_year}) is a placeholder too: authors
# write it by accident and it must render, never leak as literal text into lore.
SINGLE_TOKEN=re.compile(r'(?<!\{)\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)(?::([^{}]+))?\}(?!\})')
# Anything placeholder-shaped left after rendering (JSON objects never match: they start with a quote).
UNRENDERED=re.compile(r'\{\{[^{}]*\}\}|\{[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+(?::[^{}]*)?\}')


def render(text, values):
    def replace(match):
        try:value=lookup(values,match[1])
        except (KeyError,TypeError) as exc:raise ValueError('Unknown template placeholder: '+match[0]) from exc
        fmt=match[2]
        return format(value,fmt) if fmt else str(value)
    rendered=SINGLE_TOKEN.sub(replace,TOKEN.sub(replace,text))
    leftover=UNRENDERED.search(rendered)
    if leftover:raise ValueError('Unrendered template placeholder: '+leftover.group())
    return rendered


def generated_files(values):
    result={}
    for source in sorted((ROOT/'templates').rglob('*')):
        if source.is_file():
            result[ROOT/source.relative_to(ROOT/'templates')]=render(source.read_text(),values)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check',action='store_true',help='Compare generated files without writing')
    parser.add_argument('--summary',action='store_true',help='Print summary instead of the full numeric ledger')
    args=parser.parse_args()
    values=compute()
    files={ROOT/'physics.json':json.dumps(values,ensure_ascii=False,indent=2,allow_nan=False)+'\n',**generated_files(values)}
    stale=[str(path.relative_to(ROOT)) for path,body in files.items() if not path.exists() or path.read_text()!=body]
    if args.check:
        if stale:parser.exit(1,'Stale generated lore: '+', '.join(stale)+'\n')
    else:
        for path,body in files.items():path.parent.mkdir(parents=True,exist_ok=True);path.write_text(body)
    if not args.summary and not args.check:
        print(files[ROOT/'physics.json'],end='')
    for name in ('trip1','trip2'):
        row=values[name]
        print(f"{name}: Earth={row['earth_years']} yr; ship={row['ship_years']:.6f} yr; gamma={row['peak_gamma']:.6f}; beta={row['peak_beta']:.8f}; turn={row['turnaround_ly']:.6f} ly; eta/burn={row['rapidity_per_burn']:.6f}")
    print('photon trip1: one-way={:.6f}; round-trip={:.6f}'.format(values['rocket']['trip1']['photon']['one_way_R'],values['rocket']['trip1']['photon']['round_trip_R']))
    print('route: ship={ship_years:.6f} yr; cryo={cryo_years:.6f} yr; peak gamma={peak_gamma:.6f}'.format(**values['route']))
    print(('CHECK OK: ' if args.check else 'WROTE: ')+str(len(files))+' generated files')


if __name__=='__main__':main()
