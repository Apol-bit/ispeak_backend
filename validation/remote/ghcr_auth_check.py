"""One-shot GET-only authorization inspection. No Docker or upload operations."""
import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

CODES={'DENIED','UNAUTHORIZED','NAME_UNKNOWN','insufficient_scope','permission_denied'}

def request(url,headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(url,headers=headers,method='GET'),timeout=20) as response:
            return response.status,json.loads(response.read(1048576)),response.headers
    except urllib.error.HTTPError as error:
        try: body=json.loads(error.read(65536))
        except Exception:body={}
        return error.code,body,error.headers
    except Exception:
        return None,{},{}

def categories(body):
    return sorted({e.get('code') for e in body.get('errors',[]) if isinstance(e,dict) and e.get('code') in CODES}) if isinstance(body,dict) else []

def main():
    required={'GITHUB_REPOSITORY':'Apol-bit/ispeak_backend','GITHUB_ACTOR':'Apol-bit',
              'GITHUB_EVENT_NAME':'push','GITHUB_REF':'refs/heads/ci/validate-node-dfa3138f-20261021','GITHUB_RUN_ATTEMPT':'1'}
    if any(os.environ.get(k)!=v for k,v in required.items()):raise RuntimeError('Execution identity mismatch')
    token=os.environ.pop('PUBLISHER_TOKEN','')
    if not token:raise RuntimeError('Protected Publisher secret unavailable')
    headers={'User-Agent':'iSpeak-readonly-auth','Accept':'application/vnd.github+json','Authorization':'Bearer '+token}
    status,user,h=request('https://api.github.com/user',headers)
    scopes=h.get('X-OAuth-Scopes')
    available=set(x.strip() for x in scopes.split(',')) if scopes is not None else None
    login=user.get('login') if status==200 else None
    result={'github_user_http':status,'login':login,'scope_header_present':scopes is not None,
            'read_packages':('read:packages' in available or 'write:packages' in available or 'delete:packages' in available) if available is not None else None,
            'write_packages':('write:packages' in available or 'delete:packages' in available) if available is not None else None}
    status,package,_=request('https://api.github.com/user/packages/container/ispeak-node',headers)
    result['package']={'http':status,'existence':'confirmed' if status==200 else 'undetermined',
                       'visibility':package.get('visibility') if status==200 else None,'error_codes':categories(package)}
    scope='repository:apol-bit/ispeak-node:pull,push'
    auth=base64.b64encode(('Apol-bit:'+token).encode()).decode()
    status,body,_=request('https://ghcr.io/token?'+urllib.parse.urlencode({'service':'ghcr.io','scope':scope}),
                          {'User-Agent':'iSpeak-readonly-auth','Authorization':'Basic '+auth})
    actions=None
    bearer=body.get('token') or body.get('access_token') if isinstance(body,dict) else None
    # JWT claims, if supplied, are diagnostic only; no signature verification claim.
    if bearer and len(bearer.split('.'))==3:
        try:
            payload=bearer.split('.')[1];claims=json.loads(base64.urlsafe_b64decode(payload+'='*((-len(payload))%4)))
            actions=sorted({a for entry in claims.get('access',[]) if entry.get('type')=='repository' and entry.get('name')=='apol-bit/ispeak-node' for a in entry.get('actions',[]) if a in ('pull','push')})
        except Exception:pass
    result['registry']={'http':status,'requested_actions':['pull','push'],'reported_actions':actions,
                        'reported_actions_verified':False,'token_issued':bool(bearer), 'error_codes':categories(body),
                        'write_permission_proven':False}
    result['no_upload_performed']=True
    print(json.dumps(result),flush=True)
    return 0 if result['github_user_http']==200 and status==200 else 1

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception:raise SystemExit('Read-only authorization check stopped; raw details withheld')
